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

const PRODUCT_LABELS: Record<string, string> = {
  armorclaude: 'ArmorClaude',
  armorcodex: 'ArmorCodex',
  armorcopilot: 'ArmorCopilot',
  armorclaw: 'ArmorClaw',
  platform: 'ArmorIQ Platform',
  sdk: 'ArmorIQ SDK',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function renderSuccessHtml(opts: { email?: string; product?: string; orgId?: string }): string {
  const productKey = (opts.product ?? '').toLowerCase().trim();
  const productLabel = PRODUCT_LABELS[productKey] ?? null;
  const emailHtml = opts.email
    ? `<div class="email">${escapeHtml(opts.email)}</div>`
    : '';
  const productHtml = productLabel
    ? `<div class="chip">Connected to ${escapeHtml(productLabel)}</div>`
    : '';
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorized · ArmorIQ</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 27 27"><path d="M6.25 16.18 9.14 11.97 11.83 15.88 14.53 11.97 17.17 15.88 20.06 11.71" stroke="#D97D55" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="13.15" cy="13.85" r="12.15" stroke="#D97D55" stroke-width="2" fill="none"/></svg>`,
)}">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif;
    background: #fafafa;
    color: #111;
    display: flex; flex-direction: column;
    min-height: 100vh;
  }
  header {
    padding: 48px 32px 24px;
    display: flex; flex-direction: column; align-items: center; gap: 14px;
  }
  header svg.mark { width: 72px; height: 72px; }
  header .wordmark { font-weight: 700; font-size: 26px; letter-spacing: -0.02em; color: #111; }
  main {
    flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px;
  }
  .card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
    padding: 40px 36px; max-width: 460px; width: 100%; text-align: center;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .check {
    width: 64px; height: 64px; border-radius: 999px;
    background: #dcfce7; color: #16a34a;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 18px;
  }
  .check svg { width: 32px; height: 32px; }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: -0.01em; }
  p.lead { margin: 0 0 4px; color: #4b5563; font-size: 14px; line-height: 1.5; }
  .email { font-size: 13px; color: #111; font-weight: 600; margin-top: 14px; }
  .chip {
    display: inline-block; margin-top: 10px;
    padding: 4px 10px; border-radius: 999px;
    background: #f3f4f6; color: #374151;
    font-size: 12px; font-weight: 500;
  }
  .hint {
    margin-top: 20px; padding-top: 18px; border-top: 1px solid #f1f5f9;
    color: #6b7280; font-size: 12px;
  }
  footer {
    padding: 22px 32px; color: #6b7280; font-size: 12px;
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px;
    border-top: 1px solid #eef0f3;
  }
  footer nav a { color: #6b7280; text-decoration: none; margin-left: 16px; }
  footer nav a:hover { color: #111; text-decoration: underline; }
</style>
</head>
<body>
<header>
  <svg class="mark" viewBox="0 0 27 27" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6.25 16.18 9.14 11.97 11.83 15.88 14.53 11.97 17.17 15.88 20.06 11.71" stroke="#D97D55" stroke-width="2" stroke-linecap="round"/>
    <circle cx="13.15" cy="13.85" r="12.15" stroke="#D97D55" stroke-width="2"/>
  </svg>
  <span class="wordmark">ArmorIQ</span>
</header>
<main>
  <div class="card">
    <div class="check">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>You're all set</h1>
    <p class="lead">Your device is now connected to ArmorIQ.</p>
    ${emailHtml}
    ${productHtml}
    <div class="hint">You can close this tab and return to your terminal.</div>
  </div>
</main>
<footer>
  <div>© ${year} ArmorIQ Inc.</div>
  <nav>
    <a href="https://docs.armoriq.ai" target="_blank" rel="noreferrer">Docs</a>
    <a href="https://dev.armoriq.ai" target="_blank" rel="noreferrer">Dashboard</a>
    <a href="https://armoriq.ai/privacy" target="_blank" rel="noreferrer">Privacy</a>
    <a href="https://armoriq.ai/terms" target="_blank" rel="noreferrer">Terms</a>
  </nav>
</footer>
</body></html>`;
}

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
  product?: string,
): { server: http.Server; once: Promise<CallbackResult> } {
  let resolveResult: (r: CallbackResult) => void;
  const once = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/callback') {
      const params = Object.fromEntries(url.searchParams.entries());
      const callbackProduct = params.product || product;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderSuccessHtml({
          email: params.email,
          product: callbackProduct,
          orgId: params.org_id,
        }),
      );
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

export async function cmdLogin(args: {
  backend?: string;
  org?: string;
  product?: string;
}): Promise<number> {
  const backend = (args.backend ?? process.env.ARMORIQ_BACKEND_URL ?? backendBase()).replace(
    /\/+$/,
    '',
  );
  const requestedOrg = (args.org ?? '').trim();
  const product = (args.product ?? process.env.ARMORIQ_PRODUCT ?? '').trim();

  out('');
  out('  \x1b[1m\x1b[36m┃ ArmorIQ Login\x1b[0m');
  out('');

  const port = await findFreePort();
  const callbackUrl = `http://localhost:${port}/callback`;
  const { server, once: callbackOnce } = startCallbackServer(port, product);

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
  if (product) browserUrl += `&product=${encodeURIComponent(product)}`;

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
