#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { whoamiCommand } from './commands/whoami';

const program = new Command();

program
  .name('armoriq')
  .description('ArmorIQ CLI — authenticate and manage your ArmorIQ account')
  .version(require('../../package.json').version);

program
  .command('login')
  .description('Log in to ArmorIQ via browser (OAuth device-code flow)')
  .option('--backend <url>', 'Override backend URL')
  .action(async (options) => {
    await loginCommand(options);
  });

program
  .command('logout')
  .description('Remove saved credentials')
  .action(() => {
    logoutCommand();
  });

program
  .command('whoami')
  .description('Show current authentication status')
  .action(() => {
    whoamiCommand();
  });

program.parse();
