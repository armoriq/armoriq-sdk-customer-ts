import { ArmorIQClient } from '../src/client';
import { McpCredential } from '../src/models';

const ENV_KEYS = [
  'ARMORIQ_MCP_CREDENTIALS',
  'ARMORIQ_MCP_STRIPE_AUTH_TYPE',
  'ARMORIQ_MCP_STRIPE_TOKEN',
  'ARMORIQ_MCP_QB_AUTH_TYPE',
  'ARMORIQ_MCP_QB_API_KEY',
  'ARMORIQ_MCP_QB_HEADER_NAME',
  'ARMORIQ_MCP_BASIC_AUTH_TYPE',
  'ARMORIQ_MCP_BASIC_USERNAME',
  'ARMORIQ_MCP_BASIC_PASSWORD',
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('ArmorIQClient.resolveMcpCredentials', () => {
  beforeEach(() => clearEnv());
  afterAll(() => clearEnv());

  it('returns an empty map when no env or option is set', () => {
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({});
  });

  it('parses ARMORIQ_MCP_CREDENTIALS JSON', () => {
    process.env.ARMORIQ_MCP_CREDENTIALS = JSON.stringify({
      Stripe: { authType: 'bearer', token: 'env-json' },
    });
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({
      Stripe: { authType: 'bearer', token: 'env-json' },
    });
  });

  it('reads per-MCP env vars for bearer auth', () => {
    process.env.ARMORIQ_MCP_STRIPE_AUTH_TYPE = 'bearer';
    process.env.ARMORIQ_MCP_STRIPE_TOKEN = 'tok';
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({
      STRIPE: { authType: 'bearer', token: 'tok' },
    });
  });

  it('reads api_key with optional header name', () => {
    process.env.ARMORIQ_MCP_QB_AUTH_TYPE = 'api_key';
    process.env.ARMORIQ_MCP_QB_API_KEY = 'k123';
    process.env.ARMORIQ_MCP_QB_HEADER_NAME = 'X-Custom';
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({
      QB: { authType: 'api_key', apiKey: 'k123', headerName: 'X-Custom' },
    });
  });

  it('reads basic auth from env vars', () => {
    process.env.ARMORIQ_MCP_BASIC_AUTH_TYPE = 'basic';
    process.env.ARMORIQ_MCP_BASIC_USERNAME = 'u';
    process.env.ARMORIQ_MCP_BASIC_PASSWORD = 'p';
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({
      BASIC: { authType: 'basic', username: 'u', password: 'p' },
    });
  });

  it('lets constructor option override env-var entries', () => {
    process.env.ARMORIQ_MCP_STRIPE_AUTH_TYPE = 'bearer';
    process.env.ARMORIQ_MCP_STRIPE_TOKEN = 'env-tok';
    const fromOptions = {
      STRIPE: { authType: 'bearer' as const, token: 'opt-tok' },
    };
    expect(ArmorIQClient.resolveMcpCredentials(fromOptions)).toEqual({
      STRIPE: { authType: 'bearer', token: 'opt-tok' },
    });
  });

  it('lets per-MCP env vars override the JSON blob', () => {
    process.env.ARMORIQ_MCP_CREDENTIALS = JSON.stringify({
      STRIPE: { authType: 'bearer', token: 'json-tok' },
    });
    process.env.ARMORIQ_MCP_STRIPE_AUTH_TYPE = 'bearer';
    process.env.ARMORIQ_MCP_STRIPE_TOKEN = 'env-tok';
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({
      STRIPE: { authType: 'bearer', token: 'env-tok' },
    });
  });

  it('skips silently when the JSON blob is malformed', () => {
    process.env.ARMORIQ_MCP_CREDENTIALS = 'not-json{';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ArmorIQClient.resolveMcpCredentials()).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('ArmorIQClient.encodeMcpAuthHeader', () => {
  it('base64-encodes the credential JSON', () => {
    const cred: McpCredential = { authType: 'bearer', token: 'abc' };
    const header = ArmorIQClient.encodeMcpAuthHeader(cred);
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    expect(JSON.parse(decoded)).toEqual(cred);
  });

  it('produces the same digest as the Python SDK for a known input', () => {
    // PY:  base64.b64encode(json.dumps(cred, separators=(",",":")).encode())
    // TS:  Buffer.from(JSON.stringify(cred)).toString('base64')
    // Both must produce the exact same bytes.
    const cred: McpCredential = { authType: 'bearer', token: 'abc' };
    expect(ArmorIQClient.encodeMcpAuthHeader(cred)).toBe(
      Buffer.from('{"authType":"bearer","token":"abc"}').toString('base64'),
    );
  });
});
