import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ARMORIQ_DIR = path.join(os.homedir(), '.armoriq');
const CREDENTIALS_FILE = path.join(ARMORIQ_DIR, 'credentials.json');

export interface Credentials {
  apiKey: string;
  email: string;
  userId: string;
  orgId: string;
  savedAt: string;
}

export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.startsWith('ak_')) {
      return parsed as Credentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(ARMORIQ_DIR, { recursive: true });
  const content = JSON.stringify(creds, null, 2) + '\n';
  fs.writeFileSync(CREDENTIALS_FILE, content, { mode: 0o600 });
}

export function clearCredentials(): boolean {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}
