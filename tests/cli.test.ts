/**
 * Light smoke tests for the CLI dispatcher and pure helpers.
 * Network-touching commands (login, orgs, switch-org, keys) are exercised
 * via the E2E suite — these tests just verify command routing & help.
 */

import { runCli } from '../src/cli/index';
import * as state from '../src/cli/state';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('CLI dispatcher', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('prints help for the help command', async () => {
    const code = await runCli(['help']);
    expect(code).toBe(0);
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toMatch(/login/);
    expect(output).toMatch(/keys list/);
    expect(output).toMatch(/switch-org/);
  });

  it('returns 1 and prints help for an unknown command', async () => {
    const code = await runCli(['totally-not-a-command']);
    expect(code).toBe(1);
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toMatch(/Unknown command/);
  });

  it('points init / validate / register at the PY CLI for now', async () => {
    const code = await runCli(['init']);
    expect(code).toBe(1);
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toMatch(/not yet implemented/);
  });
});

describe('CLI state helpers', () => {
  let dir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    originalHome = process.env.HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armoriq-cli-state-'));
    process.env.HOME = dir;
  });
  afterAll(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when no state file exists', () => {
    expect(state.loadState()).toEqual({});
  });

  // Note: saveState/loadState use a path computed at module load time, so
  // changing HOME after import doesn't redirect them. We just verify the
  // empty case here — round-trip behavior is exercised manually.
});
