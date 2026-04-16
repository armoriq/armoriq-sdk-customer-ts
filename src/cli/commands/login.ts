import * as http from 'http';
import * as net from 'net';
import axios from 'axios';
import { saveCredentials, getCredentialsPath } from '../credentials';

const DEFAULT_BACKEND = 'https://staging-api.armoriq.ai';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ArmorIQ</title>
<link rel="icon" href="https://armoriq.ai/images/favicon.svg" type="image/svg+xml">
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

interface CallbackResult {
  apiKey: string;
  email: string;
  userId: string;
  orgId: string;
}

function startCallbackServer(port: number): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (url.pathname === '/callback') {
        const apiKey = url.searchParams.get('key') || '';
        const email = url.searchParams.get('email') || '';
        const userId = url.searchParams.get('user_id') || '';
        const orgId = url.searchParams.get('org_id') || '';

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Connection': 'close',
        });
        res.end(SUCCESS_HTML, () => {
          // Force-close all connections so Node can exit
          clearTimeout(timeoutHandle);
          server.close();
          server.closeAllConnections?.();
          setImmediate(() => {
            if (apiKey) {
              resolve({ apiKey, email, userId, orgId });
            } else {
              reject(new Error('No API key received in callback'));
            }
          });
        });
      } else {
        res.writeHead(404, { 'Connection': 'close' });
        res.end('Not found');
      }
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);

    // Timeout after 15 minutes — use unref() so it doesn't keep Node alive
    timeoutHandle = setTimeout(() => {
      server.close();
      server.closeAllConnections?.();
      reject(new Error('Timed out waiting for authorization'));
    }, 15 * 60 * 1000);
    timeoutHandle.unref();
  });
}

export async function loginCommand(options: { backend?: string }) {
  const backend = options.backend || process.env.ARMORIQ_BACKEND_URL || DEFAULT_BACKEND;

  console.log('');
  console.log('  \x1b[1m\x1b[36m┃ ArmorIQ Login\x1b[0m');
  console.log('');

  // Step 1: find a free port and start the local callback server
  const port = await findFreePort();
  const callbackUrl = `http://localhost:${port}/callback`;
  const callbackPromise = startCallbackServer(port);

  // Step 2: request device code from backend (include our callback URL)
  let deviceResponse: DeviceCodeResponse;
  try {
    const res = await axios.post(
      `${backend}/auth/device/code`,
      { callback_url: callbackUrl },
      { timeout: 10000 },
    );
    deviceResponse = res.data;
  } catch (err: any) {
    const msg = err.response?.data?.message || err.response?.statusText || err.message || 'Unknown error';
    const status = err.response?.status || '';
    const detail = err.code || '';
    console.error(`  \x1b[31m✘\x1b[0m Failed to request device code: ${msg}${status ? ` (HTTP ${status})` : ''}${detail ? ` [${detail}]` : ''}`);
    process.exit(1);
  }

  const { user_code, verification_uri_complete } = deviceResponse;

  // Step 3: open browser
  const browserUrl = `${verification_uri_complete}&callback=${encodeURIComponent(callbackUrl)}`;
  console.log(`  Opening browser...\n`);

  try {
    const open = (await import('open')).default;
    await open(browserUrl);
  } catch {
    console.log('  \x1b[33m!\x1b[0m Browser didn\'t open automatically.');
  }

  console.log(`  If the browser didn't open, visit:`);
  console.log(`    \x1b[36m\x1b[1m${browserUrl}\x1b[0m\n`);
  console.log(`  Confirm this code in your browser: \x1b[1m${user_code}\x1b[0m\n`);

  process.stdout.write('  Waiting for authorization...');

  // Step 4: wait for the callback OR poll as fallback
  try {
    const result = await Promise.race([
      callbackPromise,
      pollFallback(backend, deviceResponse.device_code, deviceResponse.interval, deviceResponse.expires_in),
    ]);

    process.stdout.write(' \x1b[32m✔\x1b[0m\n');
    console.log('');
    console.log(`  \x1b[32m✔\x1b[0m Logged in as \x1b[1m${result.email || 'unknown'}\x1b[0m`);

    saveCredentials({
      apiKey: result.apiKey,
      email: result.email,
      userId: result.userId,
      orgId: result.orgId,
      savedAt: new Date().toISOString(),
    });

    console.log(`  \x1b[32m✔\x1b[0m API key saved to ${getCredentialsPath()}`);
    console.log('');
  } catch (err: any) {
    process.stdout.write(' \x1b[31m✘\x1b[0m\n');
    console.error(`  \x1b[31m✘\x1b[0m ${err.message || 'Authorization failed'}`);
    process.exit(1);
  }
}

async function pollFallback(
  backend: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<CallbackResult> {
  const pollIntervalMs = (interval || 5) * 1000;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const res = await axios.post(
        `${backend}/auth/device/token`,
        { deviceCode },
        { timeout: 10000 },
      );
      const data = res.data;

      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        continue;
      }
      if (data.error) {
        throw new Error(data.error_description || data.error);
      }
      if (data.api_key) {
        return {
          apiKey: data.api_key,
          email: data.email || '',
          userId: data.user_id || '',
          orgId: data.org_id || '',
        };
      }
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Timed out waiting for authorization. Run `armoriq login` again.');
}
