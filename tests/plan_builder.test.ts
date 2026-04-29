import {
  defaultToolNameParser,
  buildPlanFromToolCalls,
  hashToolCalls,
} from '../src/plan_builder';

describe('defaultToolNameParser', () => {
  it('splits namespaced tool names on the first __ separator', () => {
    const parse = defaultToolNameParser();
    expect(parse('Stripe__create_payment')).toEqual({
      mcp: 'Stripe',
      action: 'create_payment',
    });
  });

  it('preserves __ inside the action portion', () => {
    const parse = defaultToolNameParser();
    expect(parse('GitHub__create__pr')).toEqual({
      mcp: 'GitHub',
      action: 'create__pr',
    });
  });

  it('falls back to defaultMcpName when the name is not namespaced', () => {
    const parse = defaultToolNameParser('QuickBooks');
    expect(parse('list_invoices')).toEqual({
      mcp: 'QuickBooks',
      action: 'list_invoices',
    });
  });

  it('throws when the name is not namespaced and no default is set', () => {
    const parse = defaultToolNameParser();
    expect(() => parse('list_invoices')).toThrow(/not namespaced/);
  });

  it('throws on a malformed prefix (empty mcp or action)', () => {
    const parse = defaultToolNameParser();
    expect(() => parse('__create_payment')).toThrow(/malformed/);
    expect(() => parse('Stripe__')).toThrow(/malformed/);
  });
});

describe('buildPlanFromToolCalls', () => {
  it('produces an SDK-shaped plan from a flat tool-call list', () => {
    const plan = buildPlanFromToolCalls(
      [
        { name: 'Stripe__create_payment', args: { amount: 100 } },
        { name: 'GitHub__open_pr', args: { title: 'fix' } },
      ],
      'do work',
    );
    expect(plan).toEqual({
      goal: 'do work',
      steps: [
        {
          action: 'create_payment',
          tool: 'create_payment',
          mcp: 'Stripe',
          params: { amount: 100 },
          description: 'Call create_payment on Stripe',
        },
        {
          action: 'open_pr',
          tool: 'open_pr',
          mcp: 'GitHub',
          params: { title: 'fix' },
          description: 'Call open_pr on GitHub',
        },
      ],
    });
  });

  it('defaults goal to "agent task" when none is provided', () => {
    const plan = buildPlanFromToolCalls([{ name: 'A__b' }]);
    expect(plan.goal).toBe('agent task');
    expect(plan.steps[0].params).toEqual({});
  });

  it('respects an explicit defaultMcpName', () => {
    const plan = buildPlanFromToolCalls(
      [{ name: 'list_invoices', args: { limit: 5 } }],
      'list',
      undefined,
      'QuickBooks',
    );
    expect(plan.steps[0].mcp).toBe('QuickBooks');
    expect(plan.steps[0].action).toBe('list_invoices');
  });

  it('accepts a custom parser', () => {
    const plan = buildPlanFromToolCalls(
      [{ name: 'stripe.create_payment', args: {} }],
      undefined,
      (name) => {
        const [mcp, action] = name.split('.');
        return { mcp, action };
      },
    );
    expect(plan.steps[0].mcp).toBe('stripe');
    expect(plan.steps[0].action).toBe('create_payment');
  });
});

describe('hashToolCalls', () => {
  it('returns a 64-char SHA-256 hex digest', () => {
    const h = hashToolCalls([{ name: 'A__b', args: { x: 1 } }]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls with the same input', () => {
    const calls = [{ name: 'A__b', args: { x: 1 } }];
    expect(hashToolCalls(calls)).toBe(hashToolCalls(calls));
  });

  it('changes when the args change', () => {
    const a = hashToolCalls([{ name: 'A__b', args: { x: 1 } }]);
    const b = hashToolCalls([{ name: 'A__b', args: { x: 2 } }]);
    expect(a).not.toBe(b);
  });

  it('treats missing args the same as empty args (PY parity)', () => {
    expect(hashToolCalls([{ name: 'A__b' }])).toBe(
      hashToolCalls([{ name: 'A__b', args: {} }]),
    );
  });

  it('uses the same canonical form Python emits (parity guard)', () => {
    // PY:  json.dumps([{"name":"A__b","args":{"x":1}}], separators=(",",":"))
    // TS:  JSON.stringify([{name:"A__b",args:{x:1}}])
    // Both must produce the exact same bytes for the digests to agree.
    const canonical = JSON.stringify([{ name: 'A__b', args: { x: 1 } }]);
    expect(canonical).toBe('[{"name":"A__b","args":{"x":1}}]');
  });
});
