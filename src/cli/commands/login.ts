import axios from 'axios';
import { saveCredentials, getCredentialsPath } from '../credentials';

const DEFAULT_BACKEND = 'https://staging-api.armoriq.ai';
const POLL_INTERVAL_MS = 5000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  error?: string;
  error_description?: string;
  api_key?: string;
  email?: string;
  user_id?: string;
  org_id?: string;
}

export async function loginCommand(options: { backend?: string }) {
  const backend = options.backend || process.env.ARMORIQ_BACKEND_URL || DEFAULT_BACKEND;

  console.log('');
  console.log('  \x1b[1m\x1b[36m┃ ArmorIQ Login\x1b[0m');
  console.log('');

  // Step 1: request device code
  let deviceResponse: DeviceCodeResponse;
  try {
    const res = await axios.post(`${backend}/auth/device/code`, {}, { timeout: 10000 });
    deviceResponse = res.data;
  } catch (err: any) {
    const msg = err.response?.data?.message || err.message || 'Unknown error';
    console.error(`  \x1b[31m✘\x1b[0m Failed to request device code: ${msg}`);
    process.exit(1);
  }

  const { device_code, user_code, verification_uri_complete, expires_in, interval } = deviceResponse;

  // Step 2: open browser
  console.log(`  Opening browser at:\n    \x1b[36m\x1b[1m${verification_uri_complete}\x1b[0m`);
  console.log('');

  try {
    // Dynamic import for ESM-only `open` package
    const open = (await import('open')).default;
    await open(verification_uri_complete);
  } catch {
    console.log('  \x1b[33m!\x1b[0m Browser didn\'t open automatically.');
    console.log(`  Visit the URL above and enter code: \x1b[1m${user_code}\x1b[0m`);
  }

  console.log(`  Confirm this code in your browser: \x1b[1m${user_code}\x1b[0m`);
  console.log('');

  // Step 3: poll for token
  const pollIntervalMs = (interval || 5) * 1000;
  const deadline = Date.now() + expires_in * 1000;
  let dots = '';

  while (Date.now() < deadline) {
    process.stdout.write(`\r  Waiting for authorization${dots.padEnd(3, ' ')}`);
    dots = dots.length >= 3 ? '' : dots + '.';

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const res = await axios.post<PollResponse>(
        `${backend}/auth/device/token`,
        { deviceCode: device_code },
        { timeout: 10000 },
      );
      const data = res.data;

      if (data.error === 'authorization_pending') {
        continue;
      }

      if (data.error === 'slow_down') {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      if (data.error === 'expired_token') {
        process.stdout.write('\r');
        console.log('  \x1b[33m!\x1b[0m Device code expired. Please run `armoriq login` again.');
        process.exit(1);
      }

      if (data.error === 'access_denied') {
        process.stdout.write('\r');
        console.log('  \x1b[31m✘\x1b[0m Authorization denied.');
        process.exit(1);
      }

      if (data.error) {
        process.stdout.write('\r');
        console.log(`  \x1b[31m✘\x1b[0m ${data.error_description || data.error}`);
        process.exit(1);
      }

      // Success
      if (data.api_key) {
        process.stdout.write('\r');
        console.log(`  Waiting for authorization... \x1b[32m✔\x1b[0m`);
        console.log('');
        console.log(`  \x1b[32m✔\x1b[0m Logged in as \x1b[1m${data.email || 'unknown'}\x1b[0m`);

        saveCredentials({
          apiKey: data.api_key,
          email: data.email || '',
          userId: data.user_id || '',
          orgId: data.org_id || '',
          savedAt: new Date().toISOString(),
        });

        console.log(`  \x1b[32m✔\x1b[0m API key saved to ${getCredentialsPath()}`);
        console.log('');
        console.log('  \x1b[2mUse it via:\x1b[0m');
        console.log('    \x1b[2m- SDK: new ArmorIQClient({}) — auto-loaded from credentials file\x1b[0m');
        console.log('    \x1b[2m- Env: export ARMORIQ_API_KEY=$(cat ~/.armoriq/credentials.json | jq -r .apiKey)\x1b[0m');
        console.log('    \x1b[2m- Claude Code: set api_key in /plugin → armorclaude → Configure\x1b[0m');
        console.log('');
        return;
      }
    } catch (err: any) {
      // Network errors during polling are retried silently
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        continue;
      }
    }
  }

  // Timeout
  process.stdout.write('\r');
  console.log('  \x1b[33m!\x1b[0m Timed out waiting for authorization. Please run `armoriq login` again.');
  process.exit(1);
}
