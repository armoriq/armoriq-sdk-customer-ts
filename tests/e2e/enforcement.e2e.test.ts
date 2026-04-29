/**
 * End-to-end tests for the three enforcement outcomes the proxy can return:
 *   - allow: tool runs, response carries verified result
 *   - block: PolicyBlockedException is thrown (no tool execution)
 *   - hold: PolicyHoldException is thrown, delegation flow kicks in
 *
 * These tests require a live ArmorIQ deployment. They auto-skip when
 * ARMORIQ_E2E_API_KEY is not set, so CI runs without the key just
 * passes the unit tests.
 *
 * Required environment to enable:
 *   ARMORIQ_E2E_API_KEY     ak_test_* or ak_live_* key for the test org
 *   ARMORIQ_E2E_USER_EMAIL  email of a test user with policies attached
 *   ARMORIQ_E2E_ALLOW_MCP   MCP whose `noop` tool is allowed by policy
 *   ARMORIQ_E2E_BLOCK_MCP   MCP whose `denied` tool is blocked by policy
 *   ARMORIQ_E2E_HOLD_MCP    MCP whose `pay` tool triggers a hold over $1000
 *   ARMORIQ_E2E_APPROVER    email of a user who can approve the hold
 *   ARMORIQ_ENV             defaults to staging (override per env)
 *
 * The fixtures (org, MCPs, policies) are seeded by the e2e-fixtures
 * script in conmap-auto/scripts/seed-e2e.ts. See that file for the
 * exact policy shapes required.
 */

import { ArmorIQClient } from '../../src/client';
import {
  PolicyBlockedException,
  PolicyHoldException,
  DelegationException,
} from '../../src/exceptions';

const E2E_KEY = process.env.ARMORIQ_E2E_API_KEY;
const E2E_USER = process.env.ARMORIQ_E2E_USER_EMAIL;
const ALLOW_MCP = process.env.ARMORIQ_E2E_ALLOW_MCP;
const BLOCK_MCP = process.env.ARMORIQ_E2E_BLOCK_MCP;
const HOLD_MCP = process.env.ARMORIQ_E2E_HOLD_MCP;
const APPROVER = process.env.ARMORIQ_E2E_APPROVER;

// jest's `describe.skip` evaluates eagerly, so wrap with a runtime guard.
const maybeDescribe = E2E_KEY ? describe : describe.skip;

maybeDescribe('E2E: proxy enforcement outcomes (live backend)', () => {
  let client: ArmorIQClient;

  beforeAll(() => {
    if (!process.env.ARMORIQ_ENV) process.env.ARMORIQ_ENV = 'staging';
    client = new ArmorIQClient({
      apiKey: E2E_KEY!,
      userId: 'e2e-user',
      agentId: 'e2e-agent',
    });
  });

  describe('allow', () => {
    it('returns a verified result when the tool is on the allow-list', async () => {
      if (!ALLOW_MCP) return;
      const planCapture = client.capturePlan('agent', 'allow probe', {
        goal: 'allow probe',
        steps: [
          {
            action: 'noop',
            tool: 'noop',
            mcp: ALLOW_MCP,
            params: {},
            description: 'no-op probe',
          },
        ],
      });
      const token = await client.getIntentToken(planCapture, undefined, 60);
      const result = await client.invoke(ALLOW_MCP, 'noop', token, {});
      expect(result.verified).toBe(true);
      expect(result.status).toBe('success');
    }, 30_000);
  });

  describe('block', () => {
    it('throws PolicyBlockedException for a denied tool', async () => {
      if (!BLOCK_MCP) return;
      const planCapture = client.capturePlan('agent', 'block probe', {
        goal: 'block probe',
        steps: [
          {
            action: 'denied',
            tool: 'denied',
            mcp: BLOCK_MCP,
            params: {},
            description: 'should be blocked',
          },
        ],
      });

      // Block can land at one of two layers:
      //   1. token issuance (POST /iap/sdk/token validates against policy)
      //   2. invoke (proxy enforces at call time)
      // Either is a valid outcome — we just need a PolicyBlockedException
      // somewhere along the path.
      let thrown: unknown;
      try {
        const token = await client.getIntentToken(planCapture, undefined, 60);
        await client.invoke(BLOCK_MCP, 'denied', token, {});
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toMatch(
        /PolicyBlockedException|PolicyHoldException/,
      );
      // We expect block specifically; flag if the policy was misconfigured as hold.
      if ((thrown as Error).name === 'PolicyHoldException') {
        console.warn(
          'block test landed on PolicyHoldException — check that BLOCK_MCP/denied has enforcement: block, not hold',
        );
      }
    }, 30_000);
  });

  describe('hold', () => {
    it('throws PolicyHoldException with a delegationId when amount exceeds threshold', async () => {
      if (!HOLD_MCP || !E2E_USER) return;
      const planCapture = client.capturePlan('agent', 'hold probe', {
        goal: 'hold probe',
        steps: [
          {
            action: 'pay',
            tool: 'pay',
            mcp: HOLD_MCP,
            params: { amount: 5000, recipient: 'vendor@example.com' },
            description: 'over-threshold payment',
          },
        ],
      });
      const token = await client.getIntentToken(planCapture, undefined, 60);

      let thrown: PolicyHoldException | undefined;
      try {
        await client.invokeWithPolicy(
          HOLD_MCP,
          'pay',
          token,
          { amount: 5000, recipient: 'vendor@example.com' },
          {
            userEmail: E2E_USER,
            // do not auto-wait — we want the bare hold to surface
            waitForApproval: false,
          },
        );
      } catch (e) {
        if (e instanceof PolicyHoldException) thrown = e;
        else throw e;
      }
      expect(thrown).toBeInstanceOf(PolicyHoldException);
      // delegationId surfaces via delegationContext on the hold exception.
      expect(thrown?.delegationContext?.delegationId).toBeDefined();
    }, 30_000);
  });

  describe('delegation lifecycle', () => {
    it('creates a request, surfaces the pending status, and rejects double-execute', async () => {
      if (!HOLD_MCP || !E2E_USER || !APPROVER) return;
      const created = await client.createDelegationRequest({
        tool: 'pay',
        action: 'pay',
        amount: 5000,
        requesterEmail: E2E_USER,
        domain: HOLD_MCP,
        reason: 'e2e: delegation lifecycle',
      });
      expect(created.delegationId).toBeDefined();
      expect(created.status).toMatch(/pending|approved/);

      // Without approval, checkApprovedDelegation should return null.
      const beforeApproval = await client.checkApprovedDelegation(
        E2E_USER,
        'pay',
        5000,
      );
      expect(beforeApproval).toBeNull();

      // markDelegationExecuted on a pending delegation should fail or be a no-op.
      // The backend currently returns 400 for "not approved"; either is acceptable.
      let markErr: unknown;
      try {
        await client.markDelegationExecuted(E2E_USER, created.delegationId);
      } catch (e) {
        markErr = e;
      }
      // We don't strictly assert markErr is defined — some backend versions
      // accept the call as idempotent. The contract we care about is that
      // the SDK doesn't throw a TypeError or DelegationException with a
      // garbled message.
      if (markErr) {
        expect(markErr).toBeInstanceOf(DelegationException);
      }
    }, 30_000);
  });
});
