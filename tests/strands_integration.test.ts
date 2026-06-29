import { ArmorIQStrandsPlugin } from '../src/integrations/strands';

// Build a plugin with a fake session so we test the enforcement decision logic
// (allow/block/hold/fail-closed) without strands or a live backend.
function makePlugin(checkResult: any, throwErr?: Error): any {
  const plugin: any = new ArmorIQStrandsPlugin({
    factory: {} as any,
    scope: {} as any,
    userEmail: 'u@acme.com',
    parser: ((n: string) => ({ mcp: 'm', action: n })) as any,
  });
  plugin.session = {
    check: async () => {
      if (throwErr) throw throwErr;
      return checkResult;
    },
  };
  plugin.planStarted = true; // skip plan minting
  return plugin;
}

describe('ArmorIQStrandsPlugin.beforeToolCall', () => {
  it('allow: does not cancel', async () => {
    const p = makePlugin({ allowed: true, action: 'allow' });
    const ev: any = { toolUse: { name: 'Stripe__charge', input: { amount: 10 } } };
    await p.beforeToolCall(ev);
    expect(ev.cancel).toBeUndefined();
  });

  it('block: cancels the tool', async () => {
    const p = makePlugin({ allowed: false, action: 'block', reason: 'not allowed' });
    const ev: any = { toolUse: { name: 'Stripe__charge', input: { amount: 999999 } } };
    await p.beforeToolCall(ev);
    expect(typeof ev.cancel).toBe('string');
    expect(ev.cancel).toContain('block');
  });

  it('hold not approved: cancels the tool', async () => {
    const p = makePlugin({ allowed: false, action: 'hold', reason: 'awaiting approval' });
    const ev: any = { toolUse: { name: 'Stripe__refund', input: { amount: 500 } } };
    await p.beforeToolCall(ev);
    expect(ev.cancel).toContain('hold');
  });

  it('hold approved: runs the tool', async () => {
    const p = makePlugin({ allowed: true, action: 'allow' });
    const ev: any = { toolUse: { name: 'Stripe__refund', input: { amount: 500 } } };
    await p.beforeToolCall(ev);
    expect(ev.cancel).toBeUndefined();
  });

  it('enforcement error: fails closed', async () => {
    const p = makePlugin(null, new Error('backend down'));
    const ev: any = { toolUse: { name: 'x', input: {} } };
    await p.beforeToolCall(ev);
    expect(ev.cancel).toContain('fail-closed');
  });
});
