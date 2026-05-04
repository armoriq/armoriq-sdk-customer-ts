/**
 * armoriq orgs / switch-org — list and switch ArmorIQ organizations.
 * Mirrors armoriq_sdk/cli.py:cmd_orgs / cmd_switch_org.
 */

import axios from 'axios';
import { saveCredentials } from '../../credentials';
import { CHECK, CLIError, backendBase, out, requireCredentials } from '../util';
import { appendLog, clearState, STATE_FILE } from '../state';
import * as fs from 'fs';

export async function cmdOrgs(): Promise<number> {
  const creds = requireCredentials();
  const url = `${backendBase()}/iap/sdk/orgs`;
  let response;
  try {
    response = await axios.get(url, {
      headers: { 'X-API-Key': creds.apiKey },
      timeout: 12000,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new CLIError(`Failed to reach ${url}: ${(e as Error).message}`);
  }
  if (response.status === 401) {
    throw new CLIError('API key rejected (401). Try `armoriq login` again.');
  }
  if (response.status >= 400) {
    throw new CLIError(`Failed to list orgs (HTTP ${response.status}).`);
  }
  const orgs: any[] = response.data?.data ?? [];
  if (orgs.length === 0) {
    out("You don't belong to any organizations.");
    return 0;
  }

  const nameW = Math.max('NAME'.length, ...orgs.map((o) => (o.name ?? '').length));
  const roleW = Math.max('ROLE'.length, ...orgs.map((o) => (o.userRole ?? '').length));
  const header = `  ${'NAME'.padEnd(nameW)}  ${'ORG_ID'.padEnd(36)}  ${'ROLE'.padEnd(roleW)}  MEMBERS`;
  out(header);
  out('  ' + '-'.repeat(header.length - 2));
  for (const org of orgs) {
    const marker = org.active ? `${CHECK} ` : '  ';
    const name = (org.name ?? '').padEnd(nameW);
    const orgId = (org.orgId ?? '').padEnd(36);
    const role = (org.userRole ?? '').padEnd(roleW);
    const members = String(org.memberCount ?? 0);
    out(`${marker}${name}  ${orgId}  ${role}  ${members}`);
  }
  out('');
  out(`Active org is marked with ${CHECK}. Switch with \`armoriq switch-org <name-or-id>\`.`);
  appendLog('orgs', { count: orgs.length });
  return 0;
}

export async function cmdSwitchOrg(args: { org: string; keyName?: string }): Promise<number> {
  const creds = requireCredentials();
  const target = (args.org ?? '').trim();
  if (!target) throw new CLIError('Target org (id or name) is required.');

  const url = `${backendBase()}/iap/sdk/switch-org`;
  const body: Record<string, unknown> = { org: target };
  if (args.keyName) body.keyName = args.keyName;

  let response;
  try {
    response = await axios.post(url, body, {
      headers: { 'X-API-Key': creds.apiKey, 'Content-Type': 'application/json' },
      timeout: 12000,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new CLIError(`Failed to reach ${url}: ${(e as Error).message}`);
  }
  if (response.status === 401) throw new CLIError('API key rejected (401). Try `armoriq login` again.');
  if (response.status === 403) throw new CLIError(`You are not a member of '${target}'.`);
  if (response.status === 404) throw new CLIError(`No organization named '${target}' (or matching that id).`);
  if (response.status === 400) {
    throw new CLIError(response.data?.message || 'Bad request.');
  }
  if (response.status >= 400) {
    throw new CLIError(`Switch failed (HTTP ${response.status}).`);
  }

  const payload = response.data ?? {};
  const newApiKey: string | undefined = payload.api_key;
  const newOrgId: string | undefined = payload.org_id;
  const newOrgName: string = payload.org_name ?? target;
  if (!newApiKey || !newOrgId) {
    throw new CLIError('Switch response missing api_key or org_id.');
  }

  saveCredentials({
    apiKey: newApiKey,
    email: creds.email,
    userId: creds.userId,
    orgId: newOrgId,
    savedAt: new Date().toISOString(),
  });

  // Agent registration (state.json) was org-scoped — invalidate it so the
  // next step is obvious.
  const stateExisted = fs.existsSync(STATE_FILE);
  if (stateExisted) clearState();

  out(`${CHECK} Switched to ${newOrgName} (org_id=${newOrgId})`);
  out(`${CHECK} New API key saved.`);
  if (stateExisted) {
    out('  Previous agent registration cleared. Re-run `armoriq register` in this org.');
  }
  appendLog('switch-org', { org_id: newOrgId, org_name: newOrgName, cleared_state: stateExisted });
  return 0;
}
