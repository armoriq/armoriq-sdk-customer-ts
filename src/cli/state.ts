/**
 * Local CLI state ($HOME/.armoriq/{state,cli.log}.{json,jsonl}).
 * Mirrors the layout used by armoriq_sdk/cli.py so PY and TS CLIs share the same files.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ARMORIQ_DIR = path.join(os.homedir(), '.armoriq');
export const STATE_FILE = path.join(ARMORIQ_DIR, 'state.json');
export const LOG_FILE = path.join(ARMORIQ_DIR, 'cli.log');

export type CliState = {
  registered_at?: string;
  config_path?: string;
  agent_id?: string;
  user_id?: string;
  environment?: string;
  proxy_endpoint?: string;
  mcp_servers?: string[];
  [k: string]: unknown;
};

export function loadState(): CliState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as CliState;
  } catch {
    return {};
  }
}

export function saveState(state: CliState): void {
  fs.mkdirSync(ARMORIQ_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearState(): boolean {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function appendLog(event: string, details: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(ARMORIQ_DIR, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      details,
    });
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch {
    // best-effort; never throw on log write
  }
}
