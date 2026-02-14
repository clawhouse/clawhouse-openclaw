import { ClawHouseClient } from './client';
import { startClawHouseConnection } from './gateway';
import {
  CHANNEL_HINTS,
  CHANNEL_META,
  STATUS_MESSAGES,
} from './llm-definitions';
import { getClawHouseRuntime } from './runtime';
import type {
  ChannelAccountSnapshot,
  ChannelLogoutContext,
  ChannelPlugin,
  ClawHouseChannelConfig,
  OpenClawConfig,
  ResolvedClawHouseAccount,
} from './types';

function getChannelConfig(cfg: OpenClawConfig): ClawHouseChannelConfig | null {
  return cfg?.channels?.clawhouse ?? null;
}

export const clawHousePlugin: ChannelPlugin = {
  id: 'clawhouse',

  meta: CHANNEL_META,

  capabilities: {
    text: true,
    media: false,
    reactions: false,
    threads: true,
    editing: false,
  },

  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const ch = getChannelConfig(cfg);
      if (!ch) return [];
      if (ch.accounts && Object.keys(ch.accounts).length > 0) {
        return Object.keys(ch.accounts);
      }
      return ['default'];
    },

    resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedClawHouseAccount {
      const ch = getChannelConfig(cfg);
      if (!ch) {
        return {
          accountId: accountId ?? 'default',
          botToken: '',
          apiUrl: '',
          wsUrl: '',
          userId: '',
          enabled: false,
        };
      }

      const id = accountId ?? 'default';
      const acct = id !== 'default' && ch.accounts?.[id] ? ch.accounts[id] : ch;

      return {
        accountId: id,
        botToken: acct.botToken ?? '',
        apiUrl: acct.apiUrl ?? '',
        wsUrl: acct.wsUrl ?? '',
        userId: acct.userId ?? '',
        enabled: acct.enabled !== false,
      };
    },

    isConfigured(account: ResolvedClawHouseAccount): boolean {
      return Boolean(account.botToken && account.apiUrl);
    },

    isEnabled(account: ResolvedClawHouseAccount): boolean {
      return account.enabled;
    },

    describeAccount(account: ResolvedClawHouseAccount): ChannelAccountSnapshot {
      const isConfigured = Boolean(account.botToken && account.apiUrl);
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: isConfigured,
      };
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunkerMode: 'markdown',
    textChunkLimit: 2000,

    resolveTarget(_target, { cfg, accountId }) {
      // Resolve to the userId configured for this account
      const acct = clawHousePlugin.config.resolveAccount(cfg, accountId);
      if (!acct.userId) return null;
      return { to: acct.userId };
    },

    async sendText(ctx) {
      const runtime = getClawHouseRuntime();
      const cfg = runtime.config.loadConfig();
      const ch = getChannelConfig(cfg);
      if (!ch) {
        return { channel: 'clawhouse', success: false };
      }

      const acct = clawHousePlugin.config.resolveAccount(cfg, ctx.accountId);
      const client = new ClawHouseClient(acct.botToken, acct.apiUrl);

      try {
        await client.sendMessage({
          content: ctx.text,
          taskId: ctx.threadId ? String(ctx.threadId) : undefined,
        });
        return {
          channel: 'clawhouse',
          success: true,
          threadId: ctx.threadId ? String(ctx.threadId) : undefined,
        };
      } catch {
        return { channel: 'clawhouse', success: false };
      }
    },
  },

  gateway: {
    async startAccount(ctx) {
      return startClawHouseConnection(ctx);
    },

    async stopAccount(ctx) {
      const log =
        ctx.log ?? getClawHouseRuntime().logging.createLogger('clawhouse');
      log.info(`Stopping ClawHouse account ${ctx.accountId}`);
      ctx.setStatus({ running: false, lastStopAt: Date.now() });
    },

    async logoutAccount(ctx: ChannelLogoutContext) {
      const log =
        ctx.log ?? getClawHouseRuntime().logging.createLogger('clawhouse');
      const runtime = ctx.runtime as {
        config: { writeConfigFile(cfg: unknown): Promise<void> };
      };

      // Clone config immutably
      const config = JSON.parse(JSON.stringify(ctx.cfg)) as Record<
        string,
        unknown
      >;
      const channels = (config.channels ?? {}) as Record<string, unknown>;
      const clawhouse = (channels.clawhouse ?? {}) as Record<string, unknown>;

      if (ctx.accountId === 'default') {
        delete clawhouse.botToken;
      } else {
        const accounts = (clawhouse.accounts ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        if (accounts[ctx.accountId]) {
          delete accounts[ctx.accountId].botToken;
        }
      }

      channels.clawhouse = clawhouse;
      config.channels = channels;

      await runtime.config.writeConfigFile(config);
      log.info(`Cleared bot token for account ${ctx.accountId}`);

      return { cleared: true, loggedOut: true };
    },
  },

  setup: {
    applyAccountConfig(params) {
      const { cfg, accountId, input } = params;
      const config = cfg as Record<string, unknown>;
      const channels = (config.channels ?? {}) as Record<string, unknown>;
      const clawhouse = (channels.clawhouse ?? {}) as Record<string, unknown>;

      if (accountId === 'default') {
        clawhouse.botToken = input.botToken;
        clawhouse.apiUrl = input.apiUrl;
        clawhouse.wsUrl = input.wsUrl;
        clawhouse.userId = input.userId;
      } else {
        const accounts = (clawhouse.accounts ?? {}) as Record<string, unknown>;
        accounts[accountId] = {
          botToken: input.botToken,
          apiUrl: input.apiUrl,
          wsUrl: input.wsUrl,
          userId: input.userId,
          enabled: true,
        };
        clawhouse.accounts = accounts;
      }

      // Always set top-level channel enabled
      clawhouse.enabled = true;
      channels.clawhouse = clawhouse;
      config.channels = channels;

      // Register plugin entry with channel ID to prevent auto-enable
      // from creating a phantom disabled entry under the NPM package ID
      const plugins = (config.plugins ?? {}) as Record<string, unknown>;
      const entries = (plugins.entries ?? {}) as Record<string, unknown>;
      const existing = (entries.clawhouse ?? {}) as Record<string, unknown>;
      entries.clawhouse = { ...existing, enabled: true };
      plugins.entries = entries;
      config.plugins = plugins;

      return config;
    },

    validateInput(params) {
      const { input } = params;
      
      // Validate bot token
      if (!input.botToken) {
        return 'Bot token is required';
      }
      if (typeof input.botToken !== 'string') {
        return 'Bot token must be a string';
      }
      if (!input.botToken.startsWith('bot_')) {
        return 'Bot token must start with "bot_"';
      }
      if (input.botToken.length < 10) {
        return 'Bot token appears to be too short (minimum 10 characters)';
      }
      
      // Validate API URL
      if (!input.apiUrl) {
        return 'API URL is required';
      }
      if (typeof input.apiUrl !== 'string') {
        return 'API URL must be a string';
      }
      try {
        const apiUrl = new URL(input.apiUrl);
        if (apiUrl.protocol !== 'https:') {
          return 'API URL must use HTTPS protocol';
        }
      } catch {
        return 'API URL must be a valid URL';
      }
      
      // Validate WebSocket URL
      if (!input.wsUrl) {
        return 'WebSocket URL is required';
      }
      if (typeof input.wsUrl !== 'string') {
        return 'WebSocket URL must be a string';
      }
      try {
        const wsUrl = new URL(input.wsUrl);
        if (!['ws:', 'wss:'].includes(wsUrl.protocol)) {
          return 'WebSocket URL must use ws:// or wss:// protocol';
        }
      } catch {
        return 'WebSocket URL must be a valid URL';
      }
      
      // Validate User ID
      if (!input.userId) {
        return 'User ID is required';
      }
      if (typeof input.userId !== 'string') {
        return 'User ID must be a string';
      }
      if (!/^[UBPT][A-Z0-9]{10}$/i.test(input.userId)) {
        return 'User ID must be a valid ClawHouse ID (e.g. U9QF3C6X1A)';
      }
      
      return null;
    },
  },

  messaging: {
    normalizeTarget(raw: string): string | undefined {
      const trimmed = raw.trim();
      if (/^[UBPT][A-Z0-9]{10}$/i.test(trimmed)) return `user:${trimmed}`;
      return undefined;
    },
    targetResolver: {
      hint: CHANNEL_HINTS.targetResolver,
      looksLikeId(raw: string): boolean {
        const t = raw.trim();
        return /^[UBPT][A-Z0-9]{10}$/i.test(t) || /^user:/i.test(t);
      },
    },
  },

  security: {
    resolveDmPolicy({ accountId }) {
      const basePath =
        accountId && accountId !== 'default'
          ? `channels.clawhouse.accounts.${accountId}.dm.`
          : 'channels.clawhouse.dm.';
      return {
        policy: 'open',
        allowFrom: ['*'],
        allowFromPath: basePath,
        approveHint: 'ClawHouse uses bot token auth — no pairing needed.',
      };
    },
  },

  onboarding: {
    channel: 'clawhouse',

    async getStatus(ctx) {
      const ch = getChannelConfig(ctx.cfg);
      const hasBotToken = Boolean(ch?.botToken);
      const hasApiUrl = Boolean(ch?.apiUrl);
      const hasUserId = Boolean(ch?.userId);
      const configured = hasBotToken && hasApiUrl && hasUserId;

      const statusLines: string[] = [];
      if (configured) {
        statusLines.push('Bot token: configured');
        statusLines.push(`API URL: ${ch!.apiUrl}`);
        if (ch!.wsUrl) statusLines.push(`WS URL: ${ch!.wsUrl}`);
      } else {
        statusLines.push('Not configured');
      }

      return {
        channel: 'clawhouse',
        configured,
        statusLines,
        selectionHint: CHANNEL_HINTS.onboardingSelection,
        quickstartScore: configured ? 0 : 50,
      };
    },

    async configure(ctx) {
      const ch = getChannelConfig(ctx.cfg);
      const accountId = ctx.accountOverrides.accountId ?? 'default';

      const botToken = await ctx.prompter.text({
        message: 'Bot token',
        initialValue: ch?.botToken ?? '',
        placeholder: 'bot_xxxxxxxxxxxxxxxx',
        validate: (v) => {
          if (!v) return 'Bot token is required';
          if (!v.startsWith('bot_')) return 'Must start with "bot_"';
          if (v.length < 10) return 'Bot token appears to be too short';
          return undefined;
        },
      });

      const apiUrl = await ctx.prompter.text({
        message: 'API URL',
        initialValue: ch?.apiUrl ?? '',
        placeholder: 'https://app.clawhouse.net/v1/bot',
        validate: (v) => {
          if (!v) return 'API URL is required';
          try {
            const url = new URL(v);
            if (url.protocol !== 'https:') return 'Must use HTTPS protocol for security';
            return undefined;
          } catch {
            return 'Must be a valid HTTPS URL';
          }
        },
      });

      const wsUrl = await ctx.prompter.text({
        message: 'WebSocket URL',
        initialValue: ch?.wsUrl ?? '',
        placeholder: 'wss://ws.clawhouse.net',
        validate: (v) => {
          if (!v) return 'WebSocket URL is required';
          try {
            const url = new URL(v);
            if (!['ws:', 'wss:'].includes(url.protocol)) {
              return 'Must use ws:// or wss:// protocol';
            }
            return undefined;
          } catch {
            return 'Must be a valid WebSocket URL';
          }
        },
      });

      const userId = await ctx.prompter.text({
        message: 'Your ClawHouse User ID (shown in install instructions)',
        initialValue: ch?.userId ?? '',
        placeholder: 'U9QF3C6X1A',
        validate: (v) => {
          if (!v) return 'User ID is required';
          if (!/^[UBPT][A-Z0-9]{10}$/i.test(v)) {
            return 'Must be a valid ClawHouse ID (e.g. U9QF3C6X1A)';
          }
          return undefined;
        },
      });

      const updatedCfg = clawHousePlugin.setup!.applyAccountConfig({
        cfg: ctx.cfg,
        accountId,
        input: { botToken, apiUrl, wsUrl, userId },
      });

      await ctx.prompter.note('ClawHouse channel configured.', 'Done');

      return { cfg: updatedCfg, accountId };
    },

    disable(cfg: unknown) {
      const config = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
      const channels = (config.channels ?? {}) as Record<string, unknown>;
      const clawhouse = (channels.clawhouse ?? {}) as Record<string, unknown>;
      clawhouse.enabled = false;
      channels.clawhouse = clawhouse;
      config.channels = channels;
      return config;
    },
  },

  status: {
    async probeAccount(params) {
      const isConfigured = Boolean(
        params.account.botToken && params.account.apiUrl,
      );
      if (!isConfigured) {
        return { ok: false, error: STATUS_MESSAGES.probeNotConfigured };
      }
      const client = new ClawHouseClient(
        params.account.botToken,
        params.account.apiUrl,
      );
      return client.probe(params.timeoutMs);
    },

    buildAccountSnapshot(params): ChannelAccountSnapshot {
      const isConfigured = Boolean(
        params.account.botToken && params.account.apiUrl,
      );
      return {
        accountId: params.account.accountId,
        enabled: params.account.enabled,
        configured: isConfigured,
        running: params.runtime?.running,
        lastStartAt: params.runtime?.lastStartAt,
        lastStopAt: params.runtime?.lastStopAt,
        lastError: params.runtime?.lastError,
        probe: params.probe,
      };
    },

    collectStatusIssues(accounts) {
      const issues: import('./types').ChannelStatusIssue[] = [];

      for (const snap of accounts) {
        const id = snap.accountId ?? 'unknown';

        if (!snap.configured) {
          issues.push({
            channel: 'clawhouse',
            accountId: id,
            kind: 'config',
            message: STATUS_MESSAGES.notConfigured.message,
            fix: STATUS_MESSAGES.notConfigured.fix,
          });
          continue;
        }

        if (!snap.enabled) {
          issues.push({
            channel: 'clawhouse',
            accountId: id,
            kind: 'config',
            message: STATUS_MESSAGES.disabled.message,
            fix: STATUS_MESSAGES.disabled.fix,
          });
          continue;
        }

        if (!snap.running) {
          issues.push({
            channel: 'clawhouse',
            accountId: id,
            kind: 'runtime',
            message: STATUS_MESSAGES.notRunning.message,
          });
        }

        if (snap.probe && !snap.probe.ok) {
          issues.push({
            channel: 'clawhouse',
            accountId: id,
            kind: 'auth',
            message: `Probe failed: ${snap.probe.error ?? 'unknown error'}`,
            fix: STATUS_MESSAGES.probeFailed.fix,
          });
        }
      }

      return issues;
    },
  },
};
