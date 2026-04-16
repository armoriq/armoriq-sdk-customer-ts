import { clearCredentials, getCredentialsPath } from '../credentials';

export function logoutCommand() {
  const removed = clearCredentials();
  if (removed) {
    console.log(`  \x1b[32m✔\x1b[0m Credentials removed from ${getCredentialsPath()}`);
  } else {
    console.log('  \x1b[2mNo credentials found — already logged out.\x1b[0m');
  }
}
