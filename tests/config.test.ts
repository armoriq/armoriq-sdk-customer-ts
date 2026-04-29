import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseArmorIQConfig,
  loadArmorIQConfig,
  resolveEnvReference,
  resolveEnvReferences,
  saveArmorIQConfig,
  ArmorIQConfigError,
} from '../src/config';

describe('resolveEnvReference', () => {
  beforeEach(() => {
    delete process.env.MY_KEY;
  });
  it('resolves $VAR', () => {
    process.env.MY_KEY = 'abc';
    expect(resolveEnvReference('$MY_KEY')).toBe('abc');
  });
  it('resolves ${VAR}', () => {
    process.env.MY_KEY = 'abc';
    expect(resolveEnvReference('${MY_KEY}')).toBe('abc');
  });
  it('returns "" for an unset var', () => {
    expect(resolveEnvReference('$DOES_NOT_EXIST_XX')).toBe('');
  });
  it('passes literals through unchanged', () => {
    expect(resolveEnvReference('plain')).toBe('plain');
    expect(resolveEnvReference('$ with space')).toBe('$ with space');
  });
});

describe('parseArmorIQConfig', () => {
  it('parses a minimal valid config', () => {
    const cfg = parseArmorIQConfig({
      version: 'v1',
      identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
    });
    expect(cfg.identity.api_key).toBe('ak');
    expect(cfg.environment).toBe('sandbox');
    expect(cfg.proxy.url).toContain('armoriq');
    expect(cfg.intent.ttl_seconds).toBe(300);
  });

  it('rejects missing identity fields', () => {
    expect(() =>
      parseArmorIQConfig({ version: 'v1', identity: { api_key: 'ak' } }),
    ).toThrow(ArmorIQConfigError);
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      parseArmorIQConfig({
        version: 'v9',
        identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
      }),
    ).toThrow(/version/);
  });

  it('rejects bearer auth without a token', () => {
    expect(() =>
      parseArmorIQConfig({
        version: 'v1',
        identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
        mcp_servers: [{ id: 'a', url: 'https://a', auth: { type: 'bearer' } }],
      }),
    ).toThrow(/bearer/);
  });

  it('rejects duplicate mcp_server ids', () => {
    expect(() =>
      parseArmorIQConfig({
        version: 'v1',
        identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
        mcp_servers: [
          { id: 'a', url: 'https://a' },
          { id: 'a', url: 'https://b' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('normalizes auth: "none" string into the structured form', () => {
    const cfg = parseArmorIQConfig({
      version: 'v1',
      identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
      mcp_servers: [{ id: 'a', url: 'https://a', auth: 'none' }],
    });
    expect(cfg.mcp_servers[0].auth).toEqual({ type: 'none' });
  });
});

describe('resolveEnvReferences', () => {
  it('expands $VAR refs through the whole config', () => {
    process.env.AK = 'ak_test_xyz';
    process.env.URL_VAR = 'https://foo';
    process.env.TOKEN_VAR = 't0k';
    const cfg = parseArmorIQConfig({
      version: 'v1',
      identity: { api_key: '$AK', user_id: 'u', agent_id: 'a' },
      mcp_servers: [
        { id: 's', url: '$URL_VAR', auth: { type: 'bearer', token: '$TOKEN_VAR' } },
      ],
    });
    const resolved = resolveEnvReferences(cfg);
    expect(resolved.identity.api_key).toBe('ak_test_xyz');
    expect(resolved.mcp_servers[0].url).toBe('https://foo');
    expect(resolved.mcp_servers[0].auth).toEqual({ type: 'bearer', token: 't0k' });
  });
});

describe('loadArmorIQConfig + saveArmorIQConfig', () => {
  it('round-trips a config through YAML', () => {
    const tmp = path.join(os.tmpdir(), `armoriq-${Date.now()}.yaml`);
    const cfg = parseArmorIQConfig({
      version: 'v1',
      identity: { api_key: 'ak', user_id: 'u', agent_id: 'a' },
      mcp_servers: [
        { id: 's', url: 'https://s', auth: { type: 'api_key', api_key: 'k' } },
      ],
    });
    saveArmorIQConfig(cfg, tmp);
    try {
      const loaded = loadArmorIQConfig(tmp);
      expect(loaded.identity).toEqual(cfg.identity);
      expect(loaded.mcp_servers[0].auth).toEqual({ type: 'api_key', api_key: 'k' });
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('throws ArmorIQConfigError when the file is missing', () => {
    expect(() => loadArmorIQConfig('/tmp/does-not-exist-xx.yaml')).toThrow(
      ArmorIQConfigError,
    );
  });
});
