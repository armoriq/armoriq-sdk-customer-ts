/**
 * ArmorIQSession — the core primitive for framework integrations.
 *
 * Mirrors armoriq_sdk/session.py. Two main usage shapes:
 *
 * 1. Observe mode (default, local) — MCP stays on the agent side:
 *      session.startPlan(toolCalls);
 *      const decision = session.enforce(toolName, toolArgs);
 *      // ... framework calls MCP directly ...
 *      await session.report(toolName, toolArgs, result);
 *
 * 2. Proxy mode — routes through the Armoriq proxy:
 *      session.startPlan(toolCalls);
 *      return session.dispatch(toolName, toolArgs);
 */

import { ArmorIQClient } from './client';
import { IntentToken, ToolCall } from './models';
import {
  ToolNameParser,
  defaultToolNameParser,
  buildPlanFromToolCalls,
  hashToolCalls,
} from './plan_builder';

export type SessionMode = 'local' | 'proxy' | 'sdk';

export interface SessionOptions {
  toolNameParser?: ToolNameParser;
  defaultMcpName?: string;
  validitySeconds?: number;
  llm?: string;
  mode?: SessionMode;
}

export interface EnforceResult {
  allowed: boolean;
  action: 'allow' | 'block' | 'hold';
  reason?: string;
  delegationId?: string;
  matchedPolicy?: string;
}

export interface ReportOptions {
  status?: 'success' | 'failed' | 'error';
  errorMessage?: string;
  durationMs?: number;
  isDelegated?: boolean;
  delegatedBy?: string;
  delegatedTo?: string;
}

type ToolCallInput = ToolCall | { name: string; args?: Record<string, unknown> };

export class ArmorIQSession {
  public userEmail?: string;
  private client: ArmorIQClient;
  private toolNameParser: ToolNameParser;
  private defaultMcpName?: string;
  private validitySeconds: number;
  private llm: string;
  private mode: SessionMode;
  private stepIndex = 0;
  private currentPlanHash?: string;
  private currentToken?: IntentToken;
  private mcpByAction: Map<string, string> = new Map();
  private declaredTools: Set<string> = new Set();

  constructor(client: ArmorIQClient, opts?: SessionOptions) {
    this.client = client;
    const o = opts ?? {};
    this.defaultMcpName = o.defaultMcpName;
    this.toolNameParser = o.toolNameParser ?? defaultToolNameParser(this.defaultMcpName);
    this.validitySeconds = o.validitySeconds ?? 3600;
    this.llm = o.llm ?? 'agent';
    this.mode = o.mode ?? 'local';
  }

  // ─── Plan capture ──────────────────────────────────────────────

  async startPlan(toolCalls: ToolCallInput[], goal?: string): Promise<IntentToken> {
    if (!toolCalls || toolCalls.length === 0) {
      throw new Error('startPlan called with no tool calls.');
    }
    const h = hashToolCalls(toolCalls);
    if (this.currentToken && this.currentPlanHash === h) {
      return this.currentToken;
    }

    const plan = buildPlanFromToolCalls(
      toolCalls,
      goal,
      this.toolNameParser,
      this.defaultMcpName,
    );

    this.mcpByAction.clear();
    this.declaredTools.clear();
    for (const step of plan.steps) {
      this.mcpByAction.set(step.action, step.mcp);
      this.declaredTools.add(step.action);
      this.declaredTools.add(`${step.mcp}__${step.action}`);
    }
    for (const tc of toolCalls) {
      this.declaredTools.add(tc.name);
    }

    const planCapture = this.client.capturePlan(this.llm, goal ?? this.llm, plan);
    const token = await this.client.getIntentToken(planCapture, undefined, this.validitySeconds);
    this.currentPlanHash = h;
    this.currentToken = token;
    this.stepIndex = 0;
    return token;
  }

  // ─── Policy enforcement ────────────────────────────────────────

  enforceLocal(toolName: string, toolArgs: Record<string, unknown>): EnforceResult {
    if (!this.currentToken) {
      return {
        allowed: false,
        action: 'block',
        reason: 'No intent token — call startPlan() first',
      };
    }
    if (IntentToken.isExpired(this.currentToken)) {
      return { allowed: false, action: 'block', reason: 'token-expired' };
    }
    const { mcp, action } = this.toolNameParser(toolName);
    const inPlan =
      this.declaredTools.has(toolName) ||
      this.declaredTools.has(action) ||
      this.declaredTools.has(`${mcp}__${action}`);
    if (!inPlan) {
      return {
        allowed: false,
        action: 'block',
        reason: `tool-not-in-plan: '${toolName}' was not declared in the captured plan`,
      };
    }

    const pv = (this.currentToken.policyValidation ?? {}) as Record<string, any>;
    const snapshot = (this.currentToken.policySnapshot ?? []) as Array<Record<string, any>>;

    const ruleOf = (entry: any): any => {
      if (!entry || typeof entry !== 'object') return entry;
      return entry.memberRule ?? entry.clientRule ?? entry.rules ?? entry;
    };

    let governingEntry: Record<string, any> | undefined;
    if (Array.isArray(snapshot)) {
      for (const entry of snapshot) {
        const r = ruleOf(entry);
        if (!r) continue;
        const allowed = r.allowedTools ?? [];
        if (!Array.isArray(allowed)) continue;
        if (allowed.includes(action) || allowed.includes(toolName)) {
          governingEntry = entry;
          break;
        }
        if (allowed.some((t: string) => t === '*' || t.endsWith('/*') || t.endsWith('*'))) {
          governingEntry = entry;
          break;
        }
        const target = String(entry.targetName ?? entry.policyName ?? '').toLowerCase();
        if (mcp && target.includes(mcp.toLowerCase())) {
          governingEntry = entry;
          break;
        }
      }
    }

    const governingRule = governingEntry ? ruleOf(governingEntry) : undefined;
    const governingPolicyName: string | undefined = governingEntry?.policyName;
    const notAllowedAction =
      governingEntry?.defaultEnforcementAction ?? pv.default_enforcement_action ?? 'block';

    const deniedTools = pv.denied_tools;
    if (Array.isArray(deniedTools)) {
      if (deniedTools.includes(toolName) || deniedTools.includes(action)) {
        const deniedReasons: string[] = pv.denied_reasons ?? [];
        const reasonFromBackend = deniedReasons.find(
          (r) => r.startsWith(`${action}:`) || r.startsWith(`${toolName}:`),
        );
        const reason =
          reasonFromBackend ??
          (governingPolicyName
            ? `Tool '${action}' is denied by policy '${governingPolicyName}'`
            : `Tool '${action}' is denied by policy`);
        return {
          allowed: false,
          action: notAllowedAction === 'hold' ? 'hold' : 'block',
          reason,
          matchedPolicy: governingPolicyName,
        };
      }
    }

    if (governingRule) {
      const allowed = governingRule.allowedTools ?? [];
      if (Array.isArray(allowed) && allowed.length > 0) {
        const ok =
          allowed.includes('*') ||
          allowed.includes(action) ||
          allowed.includes(toolName);
        if (!ok) {
          return {
            allowed: false,
            action: notAllowedAction === 'hold' ? 'hold' : 'block',
            reason: `Tool '${action}' is not in the allowed tools for policy '${governingPolicyName}'`,
            matchedPolicy: governingPolicyName,
          };
        }
      }
    } else if (Array.isArray(snapshot) && snapshot.length > 0) {
      const allowedTools = pv.allowed_tools;
      if (Array.isArray(allowedTools) && allowedTools.length === 0) {
        return {
          allowed: false,
          action: 'block',
          reason: `Tool '${action}' is not allowed by any policy in scope`,
        };
      }
    }

    if (governingRule) {
      const thresholdDecision = this.evaluateAmountThreshold(
        governingRule,
        toolArgs,
        action,
        mcp,
      );
      if (thresholdDecision) {
        thresholdDecision.matchedPolicy = governingPolicyName;
        return thresholdDecision;
      }
    }

    return {
      allowed: true,
      action: 'allow',
      reason: 'Allowed by local policy evaluation',
      matchedPolicy: governingPolicyName,
    };
  }

  async enforceSdk(
    toolName: string,
    toolArgs: Record<string, unknown>,
    userEmail?: string,
  ): Promise<EnforceResult> {
    if (!this.currentToken) {
      throw new Error(`enforceSdk("${toolName}") called before startPlan().`);
    }
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
    const inPlan =
      this.declaredTools.has(toolName) ||
      this.declaredTools.has(action) ||
      this.declaredTools.has(`${resolvedMcp}__${action}`);
    if (!inPlan) {
      return {
        allowed: false,
        action: 'block',
        reason: `tool-not-in-plan: '${toolName}' was not declared in the captured plan`,
      };
    }

    const internals = this.client._sessionInternals();
    try {
      const response = await internals.httpClient.post(
        `${internals.backendEndpoint}/iap/sdk/enforce`,
        {
          tool: action,
          arguments: toolArgs,
          intent_token: this.currentToken.rawToken,
          policy_snapshot: this.currentToken.policySnapshot,
          user_email: userEmail,
        },
        {
          headers: { 'X-API-Key': internals.apiKey, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );
      const data = response.data ?? {};
      const allowed = data.allowed !== false;
      const actionDecision: 'allow' | 'block' | 'hold' =
        data.enforcementAction ?? (allowed ? 'allow' : 'block');
      const matched: string | undefined =
        typeof data.matchedPolicy === 'object'
          ? data.matchedPolicy?.name
          : data.matchedPolicy;
      if (actionDecision === 'hold') {
        return this.handleHold(
          toolName,
          toolArgs,
          {
            allowed: false,
            action: 'hold',
            reason: data.reason ?? data.message,
            matchedPolicy: matched,
          },
          userEmail,
        );
      }
      return {
        allowed,
        action: actionDecision,
        reason: data.reason ?? data.message,
        matchedPolicy: matched,
      };
    } catch (e) {
      console.warn(`enforceSdk() failed: ${(e as Error).message}. Allowing tool call.`);
      return { allowed: true, action: 'allow', reason: 'enforce-unavailable' };
    }
  }

  async enforce(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<EnforceResult> {
    if (!this.currentToken) {
      throw new Error(`enforce("${toolName}") called before startPlan().`);
    }
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
    const inPlan =
      this.declaredTools.has(toolName) ||
      this.declaredTools.has(action) ||
      this.declaredTools.has(`${resolvedMcp}__${action}`);
    if (!inPlan) {
      return {
        allowed: false,
        action: 'block',
        reason: `tool-not-in-plan: '${toolName}' was not declared in the captured plan`,
      };
    }

    const internals = this.client._sessionInternals();
    try {
      const payload: Record<string, unknown> = {
        enforce_only: true,
        mcp: resolvedMcp,
        tool: action,
        action,
        params: toolArgs,
        arguments: toolArgs,
        intent_token: this.currentToken.rawToken,
        plan: (this.currentToken.rawToken ?? {}).plan,
      };
      if (this.currentToken.policySnapshot) {
        payload.policy_snapshot = this.currentToken.policySnapshot;
      }
      const response = await internals.httpClient.post(
        `${internals.defaultProxyEndpoint}/invoke`,
        payload,
        {
          headers: { 'X-API-Key': internals.apiKey, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );
      if (response.status === 403) {
        const data = response.data ?? {};
        return {
          allowed: false,
          action: data.action ?? 'block',
          reason: data.reason ?? data.message,
          matchedPolicy:
            typeof data.matched_policy === 'object'
              ? data.matched_policy?.name
              : data.matched_policy,
        };
      }
      const data = response.data ?? {};
      const rawPolicy = data.matched_policy ?? data.matchedPolicy;
      const policyName =
        rawPolicy && typeof rawPolicy === 'object' ? rawPolicy.name : rawPolicy;
      const allowedFlag = data.allowed !== false;
      const actionDecision: 'allow' | 'block' | 'hold' =
        data.enforcementAction ?? data.action ?? (allowedFlag ? 'allow' : 'block');
      return {
        allowed: allowedFlag,
        action: actionDecision,
        reason: data.reason,
        delegationId: data.delegation_id,
        matchedPolicy: policyName,
      };
    } catch (e) {
      console.warn(`enforce() failed: ${(e as Error).message}. Allowing tool call.`);
      return { allowed: true, action: 'allow', reason: 'enforce-unavailable' };
    }
  }

  async check(
    toolName: string,
    toolArgs: Record<string, unknown>,
    userEmail?: string,
  ): Promise<EnforceResult> {
    if (this.mode === 'sdk') {
      return this.enforceSdk(toolName, toolArgs, userEmail);
    }
    if (this.mode === 'local') {
      const decision = this.enforceLocal(toolName, toolArgs);
      if (decision.action === 'hold') {
        return {
          ...decision,
          action: 'block',
          reason:
            (decision.reason ?? 'requires approval') +
            ' — switch ARMORIQ_MODE=proxy to enable approval workflows for this action.',
        };
      }
      return decision;
    }
    const decision = await this.enforce(toolName, toolArgs);
    if (decision.action !== 'hold') return decision;
    return this.handleHold(toolName, toolArgs, decision, userEmail);
  }

  // ─── Report / dispatch ─────────────────────────────────────────

  async report(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: unknown,
    opts?: ReportOptions,
  ): Promise<void> {
    const o = opts ?? {};
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
    const internals = this.client._sessionInternals();
    try {
      const token = this.currentToken;
      const userEmail = this.userEmail ?? this.client.userEmailOverride;
      let output: unknown = result;
      if (typeof result === 'string') output = { text: result };
      else if (result === null || result === undefined) output = {};

      await internals.httpClient.post(
        `${internals.backendEndpoint}/iap/audit`,
        {
          token: token?.jwtToken ?? token?.tokenId ?? 'unknown',
          plan_id: token?.planId ?? token?.tokenId ?? 'unknown',
          step_index: this.stepIndex,
          action,
          tool: action,
          mcp: resolvedMcp,
          input: toolArgs,
          output,
          status: o.status ?? 'success',
          error_message: o.errorMessage,
          duration_ms: o.durationMs,
          is_delegated: o.isDelegated,
          delegated_by: o.delegatedBy,
          user_email: userEmail,
          delegated_to: o.delegatedTo,
          executed_at: new Date().toISOString(),
        },
        {
          headers: { 'X-API-Key': internals.apiKey, 'Content-Type': 'application/json' },
          timeout: 5000,
        },
      );
    } catch (e) {
      console.warn(`report() failed: ${(e as Error).message}`);
    }
    this.stepIndex += 1;
  }

  async dispatch(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
    if (!this.currentToken) {
      throw new Error(`dispatch("${toolName}") called before startPlan().`);
    }
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
    const result = await this.client.invoke(resolvedMcp, action, this.currentToken, toolArgs);
    this.stepIndex += 1;
    return result.result;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async handleHold(
    toolName: string,
    toolArgs: Record<string, unknown>,
    holdDecision: EnforceResult,
    userEmail?: string,
  ): Promise<EnforceResult> {
    const internals = this.client._sessionInternals();
    const email = userEmail ?? internals.userId ?? 'unknown@armoriq';
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
    const rawAmount = ArmorIQSession.extractAmount(toolArgs) ?? 0;
    // Single normalized amount used for BOTH the approved-delegation lookup and
    // the create call — must agree, otherwise the SDK keeps creating new pending
    // rows because the existing approved one (created at safeAmount) won't match
    // a check sent at rawAmount. Backend doesn't filter by amount today (see
    // conmap-auto delegation.service.ts checkApprovedDelegation), but staying
    // consistent here is forward-compatible.
    const safeAmount = typeof rawAmount === 'number' && rawAmount >= 0.01 ? rawAmount : 0.01;

    try {
      const approved = await this.client.checkApprovedDelegation(email, action, safeAmount);
      if (approved) {
        try {
          if (approved.delegationId) {
            await this.client.markDelegationExecuted(email, approved.delegationId);
          }
        } catch {
          // best-effort
        }
        return {
          allowed: true,
          action: 'allow',
          reason: `Allowed by approved delegation ${approved.delegationId ?? ''}`.trim(),
          delegationId: approved.delegationId,
          matchedPolicy: holdDecision.matchedPolicy,
        };
      }
    } catch {
      // best-effort
    }

    let delegationId: string | undefined;
    try {
      // The conmap-auto DTO requires amount/requesterRole/requesterLimit; for
      // non-financial holds (PHI write, prior-auth, etc.) the SDK supplies
      // healthcare-shaped defaults so the row gets created. The approver UI
      // can read the original tool args from `arguments`. requesterRole
      // matches the default used elsewhere in the SDK (resolveUserRole
      // fallback in client.ts).
      const result = await this.client.createDelegationRequest({
        tool: action,
        action,
        arguments: toolArgs,
        amount: safeAmount,
        requesterEmail: email,
        requesterRole: 'agent_user',
        requesterLimit: 0,
        domain: resolvedMcp,
        planId: this.currentToken?.planId,
        intentReference: this.currentToken?.tokenId,
        merkleRoot: (this.currentToken?.rawToken ?? {}).merkle_root,
        reason: holdDecision.reason,
      });
      delegationId = result.delegationId;
    } catch (e) {
      console.warn(`createDelegationRequest failed: ${(e as Error).message}`);
    }

    return {
      allowed: false,
      action: 'hold',
      reason: holdDecision.reason ?? 'Pending approval',
      delegationId,
      matchedPolicy: holdDecision.matchedPolicy,
    };
  }

  private static extractAmount(args: Record<string, unknown>): number | undefined {
    if (!args || typeof args !== 'object') return undefined;
    for (const k of ['amount', 'value', 'total', 'price', 'cost']) {
      const v = (args as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }

  private evaluateAmountThreshold(
    rule: Record<string, any>,
    toolArgs: Record<string, unknown>,
    action: string,
    mcp: string,
  ): EnforceResult | undefined {
    const fin = rule.financialRule?.amountThreshold ?? rule.amountThreshold;
    if (!fin || typeof fin !== 'object') return undefined;
    const amount = ArmorIQSession.extractAmount(toolArgs);
    if (amount === undefined) return undefined;
    const currency = fin.currency ?? '';
    const maxPer = fin.maxPerTransaction;
    const reqApproval = fin.requireApprovalAbove;
    if (typeof maxPer === 'number' && amount > maxPer) {
      return {
        allowed: false,
        action: 'block',
        reason: `Amount ${amount} ${currency} exceeds maxPerTransaction (${maxPer})`.trim(),
      };
    }
    if (typeof reqApproval === 'number' && amount > reqApproval) {
      return {
        allowed: false,
        action: 'hold',
        reason: `Amount ${amount} ${currency} requires approval (threshold: ${reqApproval})`.trim(),
      };
    }
    return undefined;
  }

  // ─── Session state ────────────────────────────────────────────

  reset(): void {
    this.currentPlanHash = undefined;
    this.currentToken = undefined;
    this.mcpByAction.clear();
    this.declaredTools.clear();
    this.stepIndex = 0;
  }

  get currentTokenValue(): IntentToken | undefined {
    return this.currentToken;
  }

  get currentMode(): SessionMode {
    return this.mode;
  }
}
