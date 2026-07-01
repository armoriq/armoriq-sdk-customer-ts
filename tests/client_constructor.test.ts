import { ArmorIQClient } from '../src/client';

// The constructor no longer throws when USER_ID / AGENT_ID are unset; it defaults
// them to the multiuser sentinel (matches the Python SDK), so forUser(email) works
// without a base identity. These guard that behavior change.
describe('ArmorIQClient constructor — multiuser defaults', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.USER_ID;
    delete process.env.AGENT_ID;
    // ak_claw_ keys short-circuit the validateApiKey network ping.
    process.env.ARMORIQ_API_KEY = 'ak_claw_ctor-' + Date.now();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not throw when userId/agentId are unset', () => {
    expect(() => new ArmorIQClient()).not.toThrow();
  });

  it('defaults userId/agentId to the multiuser sentinel', () => {
    const c = new ArmorIQClient() as any;
    expect(c.userId).toBe('__sdk_multiuser__');
    expect(c.agentId).toBe('__sdk_multiuser__');
  });

  it('forUser(email) returns a scope without requiring a base userId', () => {
    const c = new ArmorIQClient();
    const scope = c.forUser('alice@acme.com');
    expect(scope).toBeDefined();
  });
});
