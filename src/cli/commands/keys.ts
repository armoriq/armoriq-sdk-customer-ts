/**
 * armoriq keys list / revoke / prune — API key management.
 * Mirrors PR #24 (TS) by symmetry; backend routes already exist:
 *   GET /api-keys                  (JwtAuthGuard — uses credentials JWT)
 *   POST /api-keys/:id/revoke      (JwtAuthGuard)
 */

import axios from 'axios';
import { CHECK, CLIError, backendBase, out, requireCredentials } from '../util';
import { appendLog } from '../state';

const KEY_COUNT_WARN_THRESHOLD = 8;

interface ApiKey {
  id: string;
  name?: string;
  prefix?: string;
  status?: string;
  createdAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

async function listKeys(apiKey: string): Promise<ApiKey[]> {
  const url = `${backendBase()}/api-keys`;
  const response = await axios.get(url, {
    headers: { 'X-API-Key': apiKey },
    timeout: 12000,
    validateStatus: () => true,
  });
  if (response.status === 401) throw new CLIError('API key rejected (401). Try `armoriq login` again.');
  if (response.status >= 400) throw new CLIError(`Failed to list keys (HTTP ${response.status}).`);
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function revokeKey(apiKey: string, keyId: string): Promise<void> {
  const url = `${backendBase()}/api-keys/${keyId}/revoke`;
  const response = await axios.post(url, {}, {
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    timeout: 12000,
    validateStatus: () => true,
  });
  if (response.status === 401) throw new CLIError('API key rejected (401). Try `armoriq login` again.');
  if (response.status >= 400) {
    throw new CLIError(
      `Failed to revoke key ${keyId} (HTTP ${response.status}): ${response.data?.message ?? ''}`,
    );
  }
}

export async function cmdKeysList(): Promise<number> {
  const creds = requireCredentials();
  const keys = await listKeys(creds.apiKey);
  if (keys.length === 0) {
    out('No API keys found for this account.');
    return 0;
  }
  const nameW = Math.max('NAME'.length, ...keys.map((k) => (k.name ?? '').length));
  const idW = Math.max('ID'.length, ...keys.map((k) => k.id.length));
  out(`  ${'NAME'.padEnd(nameW)}  ${'ID'.padEnd(idW)}  STATUS    LAST USED`);
  out('  ' + '-'.repeat(nameW + idW + 30));
  for (const k of keys) {
    const name = (k.name ?? '').padEnd(nameW);
    const id = k.id.padEnd(idW);
    const status = (k.status ?? 'unknown').padEnd(8);
    const last = k.lastUsedAt ?? '-';
    out(`  ${name}  ${id}  ${status}  ${last}`);
  }
  out('');
  if (keys.length > KEY_COUNT_WARN_THRESHOLD) {
    out(
      `\x1b[33m!\x1b[0m You have ${keys.length} API keys. Consider \`armoriq keys prune\` to revoke unused keys.`,
    );
  }
  appendLog('keys-list', { count: keys.length });
  return 0;
}

export async function cmdKeysRevoke(args: { id: string }): Promise<number> {
  if (!args.id) throw new CLIError('Key id is required: `armoriq keys revoke <id>`.');
  const creds = requireCredentials();
  await revokeKey(creds.apiKey, args.id);
  out(`${CHECK} Revoked key ${args.id}.`);
  appendLog('keys-revoke', { id: args.id });
  return 0;
}

export async function cmdKeysPrune(args: { yes?: boolean }): Promise<number> {
  const creds = requireCredentials();
  const keys = await listKeys(creds.apiKey);

  const now = Date.now();
  const candidates = keys.filter((k) => {
    if (k.status && k.status.toLowerCase() === 'revoked') return false;
    if (k.id === creds.apiKey) return false;
    if (k.expiresAt && new Date(k.expiresAt).getTime() < now) return true;
    if (k.lastUsedAt) {
      const ageDays = (now - new Date(k.lastUsedAt).getTime()) / 86400000;
      if (ageDays > 90) return true;
    }
    if (!k.lastUsedAt && k.createdAt) {
      const ageDays = (now - new Date(k.createdAt).getTime()) / 86400000;
      if (ageDays > 30) return true;
    }
    return false;
  });

  if (candidates.length === 0) {
    out('Nothing to prune — all keys are either active, recent, or already revoked.');
    return 0;
  }

  out(`Found ${candidates.length} prune candidate(s):`);
  for (const k of candidates) {
    out(`  ${k.id} ${k.name ?? ''} (last used ${k.lastUsedAt ?? 'never'})`);
  }
  if (!args.yes) {
    out('');
    out('Re-run with --yes to actually revoke these.');
    return 0;
  }
  for (const k of candidates) {
    try {
      await revokeKey(creds.apiKey, k.id);
      out(`${CHECK} Revoked ${k.id}`);
    } catch (e) {
      out(`\x1b[31m✘\x1b[0m Failed to revoke ${k.id}: ${(e as Error).message}`);
    }
  }
  appendLog('keys-prune', { revoked: candidates.length });
  return 0;
}
