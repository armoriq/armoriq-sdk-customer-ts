/**
 * Tests for the retry/idempotency layer on ArmorIQClient (TS port of
 * armoriq-sdk-customer/tests/test_retry_idempotency.py).
 *
 * Covers:
 *   - 5xx triggers retry, 4xx does not
 *   - Network errors trigger retry
 *   - Idempotency-Key is reused across retries
 *   - maxRetries=0 disables retry entirely
 *   - Stable Idempotency-Key for delegation/mark-executed and plan/status
 */

import { ArmorIQClient } from '../src/client';

function makeClient(maxRetries: number = 3): ArmorIQClient {
  process.env.ARMORIQ_API_KEY = 'ak_claw_test-retry-' + Date.now();
  process.env.USER_ID = 'unit-user';
  process.env.AGENT_ID = 'unit-agent';
  // ak_claw_ skips the validateApiKey ping during construction.
  return new ArmorIQClient({ maxRetries } as any);
}

function fakeResponse(status: number, data: unknown = {}) {
  return { status, data, headers: {}, statusText: '', config: {} } as any;
}

describe('ArmorIQClient._retryPost', () => {
  it('retries on 5xx and reuses the same Idempotency-Key', async () => {
    const client = makeClient();
    const calls: Array<{ url: string; key: string | undefined }> = [];
    let attempt = 0;
    (client as any).httpClient.post = jest.fn(async (url: string, _body: any, opts: any) => {
      calls.push({ url, key: opts.headers?.['Idempotency-Key'] });
      attempt += 1;
      return attempt < 3 ? fakeResponse(503) : fakeResponse(200, { ok: true });
    });
    // Skip the backoff sleeps so the test is fast.
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      cb();
      return 0 as any;
    });

    const r = await (client as any)._retryPost('https://x/y', {}, { idempotencyKey: 'key1' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.key === 'key1')).toBe(true);
    (global.setTimeout as any).mockRestore?.();
  });

  it('does not retry on 4xx', async () => {
    const client = makeClient();
    let calls = 0;
    (client as any).httpClient.post = jest.fn(async () => {
      calls += 1;
      return fakeResponse(400, { message: 'bad request' });
    });
    const r = await (client as any)._retryPost('https://x/y', {});
    expect(r.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('retries on network errors (no .response on the thrown error)', async () => {
    const client = makeClient();
    let attempt = 0;
    (client as any).httpClient.post = jest.fn(async () => {
      attempt += 1;
      if (attempt < 2) {
        const err: any = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return fakeResponse(200);
    });
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      cb();
      return 0 as any;
    });

    const r = await (client as any)._retryPost('https://x/y', {});
    expect(r.status).toBe(200);
    expect(attempt).toBe(2);
    (global.setTimeout as any).mockRestore?.();
  });

  it('maxRetries=0 disables retry entirely', async () => {
    const client = makeClient(0);
    let calls = 0;
    (client as any).httpClient.post = jest.fn(async () => {
      calls += 1;
      return fakeResponse(503);
    });
    const r = await (client as any)._retryPost('https://x/y', {});
    expect(r.status).toBe(503);
    expect(calls).toBe(1);
  });
});

describe('Stable Idempotency-Key on hot paths', () => {
  it('markDelegationExecuted uses mark-exec:<id>', async () => {
    const client = makeClient();
    const captured: Array<any> = [];
    (client as any).httpClient.post = jest.fn(async (url: string, body: any, opts: any) => {
      captured.push({ url, body, headers: opts.headers });
      return fakeResponse(200);
    });
    await client.markDelegationExecuted('u@example.com', 'deleg-123');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toMatch(/\/delegation\/mark-executed$/);
    expect(captured[0].headers['Idempotency-Key']).toBe('mark-exec:deleg-123');
    expect(captured[0].headers['X-User-Email']).toBe('u@example.com');
    expect(captured[0].body).toEqual({ delegationId: 'deleg-123' });
  });

  it('updatePlanStatus uses plan-status:<id>:<status>', async () => {
    const client = makeClient();
    const captured: Array<any> = [];
    (client as any).httpClient.post = jest.fn(async (url: string, _body: any, opts: any) => {
      captured.push({ url, headers: opts.headers });
      return fakeResponse(200);
    });
    await client.updatePlanStatus('plan-9', 'completed');
    expect(captured).toHaveLength(1);
    expect(captured[0].headers['Idempotency-Key']).toBe('plan-status:plan-9:completed');
  });

  it('completePlan delegates to updatePlanStatus(plan, "completed")', async () => {
    const client = makeClient();
    const seen: string[] = [];
    (client as any).httpClient.post = jest.fn(async (_url: string, body: any) => {
      seen.push(body.status);
      return fakeResponse(200);
    });
    await client.completePlan('plan-x');
    expect(seen).toEqual(['completed']);
  });
});
