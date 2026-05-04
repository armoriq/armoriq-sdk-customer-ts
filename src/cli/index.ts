#!/usr/bin/env node
/**
 * armoriq — TypeScript CLI for the ArmorIQ SDK.
 *
 * Mirrors the PY CLI command surface from armoriq_sdk/cli.py and cli_auth.py.
 * Supports: login, logout, whoami, orgs, switch-org, status, logs, keys.
 *
 * Note: `init`, `validate`, and `register` (which need MCP JSON-RPC discovery)
 * are not yet implemented in TS — direct users to the PY CLI for those flows
 * (or stay tuned for follow-up parity work).
 */

import { CLIError, CROSS, out } from './util';

const HELP = `
armoriq — ArmorIQ SDK CLI

Usage: armoriq <command> [options]

Commands:
  login [--org <name>]       OAuth device-code login flow
  logout                     Remove cached credentials
  whoami                     Show the currently logged-in account

  orgs                       List organizations you belong to
  switch-org <name-or-id>    Switch the active org and rotate API key
                             [--key-name <name>]

  keys list                  List API keys for this account
  keys revoke <id>           Revoke a single API key
  keys prune [--yes]         Revoke expired / unused (>90d) keys

  status                     Show local CLI state (agent, env, MCPs)
  logs [--follow]            Tail the CLI log file

  help                       Show this help

Use \`armoriq help <command>\` for command-specific options.
`;

type Argv = string[];

function parseFlag(args: Argv, name: string, hasValue: boolean = true): string | boolean | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      if (!hasValue) return true;
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    }
  }
  return undefined;
}

async function run(argv: Argv): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return 0;
  }

  switch (command) {
    case 'login': {
      const { cmdLogin } = await import('./commands/auth.js');
      const org = parseFlag(rest, 'org') as string | undefined;
      const backend = parseFlag(rest, 'backend') as string | undefined;
      return cmdLogin({ org, backend });
    }
    case 'logout': {
      const { cmdLogout } = await import('./commands/auth.js');
      return cmdLogout();
    }
    case 'whoami': {
      const { cmdWhoami } = await import('./commands/auth.js');
      return cmdWhoami();
    }
    case 'orgs': {
      const { cmdOrgs } = await import('./commands/orgs.js');
      return cmdOrgs();
    }
    case 'switch-org': {
      const { cmdSwitchOrg } = await import('./commands/orgs.js');
      const keyName = parseFlag(rest, 'key-name') as string | undefined;
      const target = rest.find((a) => !a.startsWith('--'));
      if (!target) throw new CLIError('Usage: armoriq switch-org <name-or-id>');
      return cmdSwitchOrg({ org: target, keyName });
    }
    case 'keys': {
      const sub = rest[0];
      const { cmdKeysList, cmdKeysRevoke, cmdKeysPrune } = await import('./commands/keys.js');
      if (sub === 'list') return cmdKeysList();
      if (sub === 'revoke') {
        const id = rest[1];
        if (!id) throw new CLIError('Usage: armoriq keys revoke <id>');
        return cmdKeysRevoke({ id });
      }
      if (sub === 'prune') {
        const yes = Boolean(parseFlag(rest, 'yes', false));
        return cmdKeysPrune({ yes });
      }
      out('Usage: armoriq keys list | revoke <id> | prune [--yes]');
      return 1;
    }
    case 'status': {
      const { cmdStatus } = await import('./commands/status.js');
      return cmdStatus();
    }
    case 'logs': {
      const { cmdLogs } = await import('./commands/status.js');
      const follow = Boolean(parseFlag(rest, 'follow', false));
      return cmdLogs({ follow });
    }
    case 'init':
    case 'validate':
    case 'register': {
      out(
        `'armoriq ${command}' is not yet implemented in the TypeScript CLI.\n` +
          'Use the Python CLI for now (`pip install armoriq-sdk` then `armoriq ' +
          command +
          '`), or follow this issue: https://github.com/armoriq/armoriq-sdk-customer-ts/issues/40',
      );
      return 1;
    }
    default:
      out(`Unknown command: ${command}`);
      out(HELP);
      return 1;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  run(argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof CLIError) {
        out(`  ${CROSS} ${err.message}`);
        process.exit(1);
      }
      out(`  ${CROSS} Unexpected error: ${(err as Error).message}`);
      process.exit(1);
    });
}

export { run as runCli };
