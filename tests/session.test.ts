import { ArmorIQClient } from '../src/client';
import { ArmorIQSession } from '../src/session';
import { IntentToken } from '../src/models';

// Sessions reach into client._sessionInternals() for HTTP work, but several
// methods (enforceLocal, hashing, plan capture, reset) are pure and don't
// hit the network. We unit-test those without booting a real client.

function makeClient(): ArmorIQClient {
  process.env.ARMORIQ_API_KEY = 'ak_test_unit-' + Date.now();
  process.env.USER_ID = 'unit-user';
  process.env.AGENT_ID = 'unit-agent';
  // Skip the validateApiKey ping by pretending to be ArmorClaw — it short-circuits.
  process.env.ARMORIQ_API_KEY = 'ak_claw_unit-' + Date.now();
  return new ArmorIQClient();
}

function tokenWithPolicy(policyValidation?: any, policySnapshot?: any[]): IntentToken {
  return {
    tokenId: 't',
    planHash: 'h',
    signature: 'sig',
    issuedAt: Date.now() / 1000,
    expiresAt: Date.now() / 1000 + 3600,
    policy: {},
    compositeIdentity: 'c',
    stepProofs: [],
    totalSteps: 0,
    rawToken: {},
    policyValidation,
    policySnapshot,
  };
}

describe('ArmorIQSession.enforceLocal', () => {
  let client: ArmorIQClient;
  beforeAll(() => {
    client = makeClient();
  });

  it('blocks before startPlan() is called', () => {
    const s = new ArmorIQSession(client);
    const r = s.enforceLocal('Stripe__create_payment', {});
    expect(r.allowed).toBe(false);
    expect(r.action).toBe('block');
    expect(r.reason).toMatch(/No intent token/);
  });

  it('blocks tools not declared in the captured plan', () => {
    const s = new ArmorIQSession(client);
    // Inject a token + declared tools without going through startPlan (HTTP).
    (s as any).currentToken = tokenWithPolicy();
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);

    const r = s.enforceLocal('Other__different_tool', {});
    expect(r.allowed).toBe(false);
    expect(r.action).toBe('block');
    expect(r.reason).toMatch(/tool-not-in-plan/);
  });

  it('allows declared tools when policy snapshot has wildcard allow', () => {
    const s = new ArmorIQSession(client);
    (s as any).currentToken = tokenWithPolicy({}, [
      { policyName: 'p', memberRule: { allowedTools: ['*'] } },
    ]);
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);

    const r = s.enforceLocal('Stripe__create_payment', {});
    expect(r.allowed).toBe(true);
    expect(r.action).toBe('allow');
    expect(r.matchedPolicy).toBe('p');
  });

  it('blocks when denied_tools contains the action', () => {
    const s = new ArmorIQSession(client);
    (s as any).currentToken = tokenWithPolicy(
      { denied_tools: ['create_payment'] },
      [{ policyName: 'p', memberRule: { allowedTools: ['*'] } }],
    );
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);

    const r = s.enforceLocal('Stripe__create_payment', {});
    expect(r.allowed).toBe(false);
    expect(r.action).toBe('block');
  });

  it('returns hold when amountThreshold.requireApprovalAbove is exceeded', () => {
    const s = new ArmorIQSession(client);
    (s as any).currentToken = tokenWithPolicy({}, [
      {
        policyName: 'p',
        memberRule: {
          allowedTools: ['*'],
          financialRule: {
            amountThreshold: { requireApprovalAbove: 1000, currency: 'USD' },
          },
        },
      },
    ]);
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);

    const r = s.enforceLocal('Stripe__create_payment', { amount: 5000 });
    expect(r.action).toBe('hold');
    expect(r.matchedPolicy).toBe('p');
  });

  it('returns block when amountThreshold.maxPerTransaction is exceeded', () => {
    const s = new ArmorIQSession(client);
    (s as any).currentToken = tokenWithPolicy({}, [
      {
        policyName: 'p',
        memberRule: {
          allowedTools: ['*'],
          financialRule: {
            amountThreshold: { maxPerTransaction: 1000, currency: 'USD' },
          },
        },
      },
    ]);
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);

    const r = s.enforceLocal('Stripe__create_payment', { amount: 5000 });
    expect(r.action).toBe('block');
  });

  it('blocks when the token is expired', () => {
    const s = new ArmorIQSession(client);
    const expired = tokenWithPolicy();
    expired.expiresAt = Date.now() / 1000 - 1;
    (s as any).currentToken = expired;
    (s as any).declaredTools = new Set(['Stripe__create_payment']);
    const r = s.enforceLocal('Stripe__create_payment', {});
    expect(r.action).toBe('block');
    expect(r.reason).toBe('token-expired');
  });
});

describe('ArmorIQSession.check (mode dispatch, pure path)', () => {
  let client: ArmorIQClient;
  beforeAll(() => {
    client = makeClient();
  });

  it('downgrades hold to block in local mode', async () => {
    const s = new ArmorIQSession(client, { mode: 'local' });
    (s as any).currentToken = tokenWithPolicy({}, [
      {
        policyName: 'p',
        memberRule: {
          allowedTools: ['*'],
          financialRule: { amountThreshold: { requireApprovalAbove: 100 } },
        },
      },
    ]);
    (s as any).declaredTools = new Set(['Stripe__create_payment', 'create_payment']);
    (s as any).mcpByAction = new Map([['create_payment', 'Stripe']]);
    const r = await s.check('Stripe__create_payment', { amount: 500 });
    expect(r.action).toBe('block');
    expect(r.reason).toMatch(/ARMORIQ_MODE=proxy/);
  });
});

describe('ArmorIQSession.reset', () => {
  it('clears cached plan + token state', () => {
    const client = makeClient();
    const s = new ArmorIQSession(client);
    (s as any).currentToken = tokenWithPolicy();
    (s as any).currentPlanHash = 'h';
    (s as any).declaredTools = new Set(['t']);
    s.reset();
    expect(s.currentTokenValue).toBeUndefined();
    expect((s as any).currentPlanHash).toBeUndefined();
    expect((s as any).declaredTools.size).toBe(0);
  });
});
