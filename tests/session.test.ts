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

describe('ArmorIQSession.startPlan auto-reanchor', () => {
  // autoReanchor flag removed 2026-05-13 — auto-reanchor is always on.
  // trueReanchor default flipped to true on 2026-05-17 post-soak; the legacy
  // v2 path (record delta + re-mint) still ships for callers that opt out via
  // trueReanchor: false, which is what these tests exercise.
  it('always records a Trust Update ReAnchor delta on plan growth', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, { trueReanchor: false, defaultMcpName: 'TestMcp' });

    const reanchorMock = jest.fn().mockResolvedValue({ trustId: 'tr_abc', delta: {} });
    const issueMock = jest
      .fn()
      .mockResolvedValueOnce(tokenWithPolicy())
      .mockResolvedValueOnce(tokenWithPolicy());
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    await s.startPlan([{ name: 'echo', args: { text: 'hi' } }], 'goal');
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(issueMock).toHaveBeenCalledTimes(1);

    await s.startPlan(
      [
        { name: 'echo', args: { text: 'hi' } },
        { name: 'add_step', args: { step: 'verify' } },
      ],
      'goal',
    );

    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(reanchorMock.mock.invocationCallOrder[0]).toBeLessThan(
      issueMock.mock.invocationCallOrder[1],
    );
  });

  it('Phase 4 C5c: trueReanchor=true skips re-mint and reuses the same token', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, { trueReanchor: true, defaultMcpName: 'TestMcp' });

    const reanchorMock = jest.fn().mockResolvedValue({ trustId: 'tr_chain_1', delta: {} });
    const initialToken = tokenWithPolicy();
    const issueMock = jest
      .fn()
      // Only used for the first plan (no existing token yet)
      .mockResolvedValueOnce(initialToken);
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    // First plan: no existing token, falls through to mint
    const t1 = await s.startPlan([{ name: 'echo', args: { text: 'hi' } }], 'goal');
    expect(t1).toBe(initialToken);
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(issueMock).toHaveBeenCalledTimes(1);

    // Second plan: existing token + trueReanchor → record delta and REUSE
    const t2 = await s.startPlan(
      [
        { name: 'echo', args: { text: 'hi' } },
        { name: 'add_step', args: { step: 'verify' } },
      ],
      'goal',
    );

    expect(reanchorMock).toHaveBeenCalledTimes(1);
    // CRITICAL: getIntentToken was NOT called the second time
    expect(issueMock).toHaveBeenCalledTimes(1);
    // Same JWT object reference returned
    expect(t2).toBe(initialToken);
  });

  it('Phase 4 C5c: trueReanchor reanchor failure falls back to legacy re-mint', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, { trueReanchor: true, defaultMcpName: 'TestMcp' });
    const reanchorMock = jest.fn().mockRejectedValue(new Error('chain endpoint down'));
    const issueMock = jest
      .fn()
      .mockResolvedValueOnce(tokenWithPolicy())
      .mockResolvedValueOnce(tokenWithPolicy());
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await s.startPlan([{ name: 'echo' }], 'goal');
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }], 'goal');

    // trueReanchor tries first (fails), then legacy auto-reanchor path
    // tries again (also fails) — both call reanchor, then re-mint.
    // What matters for this test: re-mint DID happen on fallback.
    expect(reanchorMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(issueMock).toHaveBeenCalledTimes(2); // fallback re-mint occurred
    warn.mockRestore();
  });

  it('Phase 4 A6: deferred granularity coalesces 3 plan growths into 1 reanchor at flush', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, {
      trueReanchor: true,
      reanchorGranularity: 'deferred',
      defaultMcpName: 'TestMcp',
    });

    const reanchorMock = jest.fn().mockResolvedValue({ trustId: 'tr_flush_1', delta: {} });
    const initialToken = tokenWithPolicy();
    const issueMock = jest.fn().mockResolvedValueOnce(initialToken);
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    // First plan — initial mint
    await s.startPlan([{ name: 'echo' }], 'goal');
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(issueMock).toHaveBeenCalledTimes(1);

    // Three growths — each should DEFER, not call reanchor
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }], 'goal');
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }, { name: 'verify' }], 'goal');
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }, { name: 'verify' }, { name: 'commit' }], 'goal');
    expect(reanchorMock).not.toHaveBeenCalled();

    // Flush — should fire ONE reanchor with the latest plan
    const result = await s.flushReanchor();
    expect(result.fired).toBe(true);
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    // The plan passed to reanchor should be the LATEST cumulative plan
    const passedPlan = reanchorMock.mock.calls[0][1];
    expect(Array.isArray(passedPlan?.steps)).toBe(true);
    expect(passedPlan.steps.length).toBe(4);

    // Second flush is a no-op (queue already drained)
    const result2 = await s.flushReanchor();
    expect(result2.fired).toBe(false);
    expect(reanchorMock).toHaveBeenCalledTimes(1);
  });

  it('Phase 4 A6: eager (default) granularity fires reanchor on every growth', async () => {
    const client = makeClient();
    // No reanchorGranularity option → defaults to 'eager'
    const s = new ArmorIQSession(client, {
      trueReanchor: true,
      defaultMcpName: 'TestMcp',
    });

    const reanchorMock = jest.fn().mockResolvedValue({ trustId: 'tr_eager', delta: {} });
    const issueMock = jest.fn().mockResolvedValueOnce(tokenWithPolicy());
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    await s.startPlan([{ name: 'echo' }], 'goal'); // initial mint
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }], 'goal');
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }, { name: 'verify' }], 'goal');

    expect(reanchorMock).toHaveBeenCalledTimes(2); // one per growth
    // flushReanchor in eager mode is a no-op
    const r = await s.flushReanchor();
    expect(r.fired).toBe(false);
  });

  it('Phase 4 A6: deferred + autoReanchor (legacy v2) still re-mints per growth, defers ONLY the delta', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, {
      // autoReanchor flag removed — always true; trueReanchor opt-in stays.
      trueReanchor: false,
      reanchorGranularity: 'deferred',
      defaultMcpName: 'TestMcp',
    });

    const reanchorMock = jest.fn().mockResolvedValue({ trustId: 'tr_v2', delta: {} });
    const issueMock = jest
      .fn()
      .mockResolvedValueOnce(tokenWithPolicy())
      .mockResolvedValueOnce(tokenWithPolicy())
      .mockResolvedValueOnce(tokenWithPolicy());
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    await s.startPlan([{ name: 'echo' }], 'goal'); // initial mint
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }], 'goal'); // re-mint, defer delta
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }, { name: 'verify' }], 'goal'); // re-mint, overwrite pending

    // re-mints happened (legacy v2 needs fresh step_proofs each time)
    expect(issueMock).toHaveBeenCalledTimes(3);
    // delta NOT yet fired
    expect(reanchorMock).not.toHaveBeenCalled();

    await s.flushReanchor();
    expect(reanchorMock).toHaveBeenCalledTimes(1);
  });

  it('continues to mint a new token even if reanchor delta record fails', async () => {
    const client = makeClient();
    const s = new ArmorIQSession(client, { trueReanchor: false, defaultMcpName: 'TestMcp' });

    const reanchorMock = jest.fn().mockRejectedValue(new Error('iap unreachable'));
    const issueMock = jest
      .fn()
      .mockResolvedValueOnce(tokenWithPolicy())
      .mockResolvedValueOnce(tokenWithPolicy());
    (client as any).reanchor = reanchorMock;
    (client as any).getIntentToken = issueMock;
    (client as any).capturePlan = (_llm: string, _goal: string, plan: any) => plan;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await s.startPlan([{ name: 'echo' }], 'goal');
    await s.startPlan([{ name: 'echo' }, { name: 'add_step' }], 'goal');

    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledTimes(2); // re-mint still happened
    warn.mockRestore();
  });
});
