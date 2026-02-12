import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClawHouseRuntime } from './runtime';

/**
 * Resolve a path for plugin data storage.
 *
 * Uses `runtime.state.resolveStateDir()` to find the OpenClaw state directory,
 * then appends `plugin-data/clawhouse/<subpath>`.
 * Falls back to `~/.openclaw/plugin-data/clawhouse/<subpath>` if the runtime
 * is not yet initialized.
 */
export function resolvePluginStorePath(subpath: string): string {
  let stateDir: string | undefined;

  try {
    const runtime = getClawHouseRuntime();
    if (runtime.state?.resolveStateDir) {
      stateDir = runtime.state.resolveStateDir();
    }
  } catch {
    // runtime not initialized yet — use fallback
  }

  if (!stateDir) {
    stateDir =
      process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw');
  }

  return join(stateDir, 'plugin-data', 'clawhouse', subpath);
}
