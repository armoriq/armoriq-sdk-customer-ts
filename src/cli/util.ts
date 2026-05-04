/**
 * Shared CLI utilities: console formatting, prompts, env-driven endpoint
 * resolution, and the "require credentials" guard.
 */

import * as readline from 'readline';
import { loadCredentials, getCredentialsPath, Credentials } from '../credentials';
import { resolveEndpoint } from '../_build_env';

export const CHECK = '\x1b[32m✔\x1b[0m';
export const CROSS = '\x1b[31m✘\x1b[0m';
export const WARN = '\x1b[33m!\x1b[0m';

export class CLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CLIError';
  }
}

export function out(message: string = ''): void {
  process.stdout.write(message + '\n');
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 16) return secret;
  return secret.slice(0, 16) + '...';
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function promptYesNo(question: string, defaultValue: boolean = false): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await prompt(`${question} [${hint}]`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export function backendBase(): string {
  const explicit = process.env.BACKEND_ENDPOINT || process.env.ARMORIQ_BACKEND_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  return resolveEndpoint('backend').replace(/\/+$/, '');
}

export function proxyBase(): string {
  const explicit = process.env.PROXY_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  return resolveEndpoint('proxy').replace(/\/+$/, '');
}

export function requireCredentials(): Credentials {
  const creds = loadCredentials();
  if (!creds) {
    throw new CLIError(
      `Not logged in (${getCredentialsPath()} missing). Run \`armoriq login\` first.`,
    );
  }
  return creds;
}
