import { loadCredentials, getCredentialsPath } from '../credentials';

export function whoamiCommand() {
  const creds = loadCredentials();
  if (!creds) {
    console.log('  \x1b[2mNot logged in. Run `armoriq login` to authenticate.\x1b[0m');
    return;
  }
  console.log('');
  console.log('  \x1b[1m\x1b[36m┃ ArmorIQ Credentials\x1b[0m');
  console.log('');
  console.log(`  Email:    \x1b[1m${creds.email || 'unknown'}\x1b[0m`);
  console.log(`  API Key:  \x1b[2m${creds.apiKey.substring(0, 16)}...\x1b[0m`);
  console.log(`  User ID:  \x1b[2m${creds.userId || 'n/a'}\x1b[0m`);
  console.log(`  Org ID:   \x1b[2m${creds.orgId || 'n/a'}\x1b[0m`);
  console.log(`  Saved at: \x1b[2m${creds.savedAt || 'n/a'}\x1b[0m`);
  console.log(`  File:     \x1b[2m${getCredentialsPath()}\x1b[0m`);
  console.log('');
}
