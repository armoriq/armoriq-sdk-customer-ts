/**
 * armoriq login / logout / whoami — OAuth 2.0 device-code flow (RFC 8628).
 * Mirrors armoriq_sdk/cli_auth.py.
 *
 * The browser approval page either redirects straight back to our
 * local callback with the key, or — if the callback can't be reached —
 * we fall back to polling /auth/device/token.
 */

import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import { exec } from 'child_process';
import axios from 'axios';
import {
  Credentials,
  saveCredentials,
  loadCredentials,
  clearCredentials,
  getCredentialsPath,
} from '../../credentials';
import { CHECK, CROSS, WARN, CLIError, out, backendBase } from '../util';

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ArmorIQ</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh;
         margin: 0; background: #f8fafc; color: #1e293b; }
  .card { text-align: center; padding: 3rem; background: white;
          border-radius: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          max-width: 400px; }
  .check { width: 64px; height: 64px; background: #dcfce7; border-radius: 50%;
           display: flex; align-items: center; justify-content: center;
           margin: 0 auto 1.5rem; }
  .check svg { width: 32px; height: 32px; color: #16a34a; }
  h2 { margin: 0 0 0.5rem; font-size: 1.25rem; }
  p { margin: 0; font-size: 0.875rem; color: #64748b; }
</style></head><body>
<div class="card">
  <div class="check">
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
    </svg>
  </div>
  <h2>Authorized</h2>
  <p>You can close this tab and return to your terminal.</p>
</div>
</body></html>`;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Could not get free port'));
      }
    });
  });
}

interface CallbackResult {
  api_key?: string;
  email?: string;
  user_id?: string;
  org_id?: string;
}

function startCallbackServer(
  port: number,
): { server: http.Server; once: Promise<CallbackResult> } {
  let resolveResult: (r: CallbackResult) => void;
  const once = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/callback') {
      const params = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      const result: CallbackResult = {
        api_key: params.key,
        email: params.email,
        user_id: params.user_id,
        org_id: params.org_id,
      };
      if (result.api_key) resolveResult(result);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, '127.0.0.1');
  return { server, once };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort */
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function cmdLogin(args: { backend?: string; org?: string }): Promise<number> {
  const backend = (args.backend ?? process.env.ARMORIQ_BACKEND_URL ?? backendBase()).replace(
    /\/+$/,
    '',
  );
  const requestedOrg = (args.org ?? '').trim();

  out('');
  out('  \x1b[1m\x1b[36m┃ ArmorIQ Login\x1b[0m');
  out('');

  const port = await findFreePort();
  const callbackUrl = `http://localhost:${port}/callback`;
  const { server, once: callbackOnce } = startCallbackServer(port);

  let dc: any;
  try {
    const r = await axios.post(`${backend}/auth/device/code`, { callback_url: callbackUrl }, { timeout: 10000 });
    dc = r.data;
  } catch (e) {
    server.close();
    out(`  ${CROSS} Failed to request device code: ${(e as Error).message}`);
    return 1;
  }

  const { device_code, user_code, verification_uri_complete } = dc;
  const interval = Number(dc.interval ?? 5) || 5;
  const expiresIn = Number(dc.expires_in ?? 600) || 600;

  const sep = verification_uri_complete.includes('?') ? '&' : '?';
  let browserUrl =
    `${verification_uri_complete}${sep}callback=${encodeURIComponent(callbackUrl)}`;
  if (requestedOrg) browserUrl += `&org=${encodeURIComponent(requestedOrg)}`;

  out('  Opening browser...\n');
  openBrowser(browserUrl);
  out('  If the browser didn\'t open, visit:');
  out(`    \x1b[36m\x1b[1m${browserUrl}\x1b[0m\n`);
  out(`  Confirm this code in your browser: \x1b[1m${user_code}\x1b[0m\n`);
  process.stdout.write('  Waiting for authorization...');

  const deadline = Date.now() + expiresIn * 1000;
  let result: CallbackResult | undefined;
  let lastErr: string | undefined;

  while (Date.now() < deadline && !result) {
    // Race callback vs poll; whichever resolves first wins.
    const callbackOrTimeout = Promise.race([
      callbackOnce.then((r) => ({ kind: 'cb', value: r }) as const),
      sleep(interval * 1000).then(() => ({ kind: 'tick' }) as const),
    ]);
    const tick = await callbackOrTimeout;
    if (tick.kind === 'cb' && tick.value.api_key) {
      result = tick.value;
      break;
    }
    try {
      const pr = await axios.post(
        `${backend}/auth/device/token`,
        { deviceCode: device_code },
        { timeout: 10000, validateStatus: () => true },
      );
      const data = pr.data ?? {};
      const err = data.error;
      if (err === 'authorization_pending' || err === 'slow_down') continue;
      if (err) {
        lastErr = data.error_description || err;
        break;
      }
      if (data.api_key) {
        result = {
          api_key: data.api_key,
          email: data.email,
          user_id: data.user_id,
          org_id: data.org_id,
        };
        break;
      }
    } catch {
      // network blip; keep polling
    }
  }

  server.close();

  if (!result || !result.api_key) {
    out(` ${CROSS}`);
    out(`  ${CROSS} ${lastErr ?? 'Timed out waiting for authorization. Run `armoriq login` again.'}`);
    return 1;
  }

  saveCredentials({
    apiKey: result.api_key,
    email: result.email ?? '',
    userId: result.user_id ?? '',
    orgId: result.org_id ?? '',
    savedAt: new Date().toISOString(),
  });
  out(` ${CHECK}`);
  out('');
  out(
    `  ${CHECK} Logged in as \x1b[1m${result.email ?? 'unknown'}\x1b[0m (org: ${result.org_id ?? 'unknown'})`,
  );
  out(`  ${CHECK} API key saved to ${getCredentialsPath()}`);
  out('');
  return 0;
}

export function cmdLogout(): number {
  if (clearCredentials()) {
    out(`  ${CHECK} Credentials removed from ${getCredentialsPath()}`);
  } else {
    out('  \x1b[2mNo credentials found — already logged out.\x1b[0m');
  }
  return 0;
}

export function cmdWhoami(): number {
  const creds = loadCredentials();
  if (!creds) {
    out('  \x1b[2mNot logged in. Run `armoriq login` to authenticate.\x1b[0m');
    return 0;
  }
  out('');
  out('  \x1b[1m\x1b[36m┃ ArmorIQ Credentials\x1b[0m');
  out('');
  const keyPreview = creds.apiKey.length > 16 ? creds.apiKey.slice(0, 16) + '...' : creds.apiKey;
  out(`  Email:    \x1b[1m${creds.email || 'unknown'}\x1b[0m`);
  out(`  API Key:  \x1b[2m${keyPreview}\x1b[0m`);
  out(`  User ID:  \x1b[2m${creds.userId || 'n/a'}\x1b[0m`);
  out(`  Org ID:   \x1b[2m${creds.orgId || 'n/a'}\x1b[0m`);
  out(`  Saved at: \x1b[2m${creds.savedAt || 'n/a'}\x1b[0m`);
  out(`  File:     \x1b[2m${getCredentialsPath()}\x1b[0m`);
  out('');
  return 0;
}
