/**
 * ArmorIQSession — the core primitive for framework integrations.
 *
 * Two modes:
 *
 * 1. Observe mode (default, new) — MCP stays on the agent side:
 *      await session.startPlan(toolCalls)                // capture plan + mint token
 *      const decision = await session.enforce(toolName, toolArgs)  // check policy
 *      // ... framework calls MCP directly ...
 *      await session.report(toolName, toolArgs, result)  // audit
 *
 * 2. Proxy mode (legacy) — routes through the Armoriq proxy:
 *      await session.startPlan(toolCalls)
 *      return session.dispatch(toolName, toolArgs)       // proxy handles everything
 */

import axios from 'axios';
import { ArmorIQClient } from './client';
import { IntentToken, MCPInvocationResult, ToolCall } from './models';
import {
  ToolNameParser,
  buildPlanFromToolCalls,
  defaultToolNameParser,
  hashToolCalls,
} from './plan-builder';

export interface SessionOptions {
  toolNameParser?: ToolNameParser;
  defaultMcpName?: string;
  validitySeconds?: number;
  llm?: string;
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

export class ArmorIQSession {
  private client: ArmorIQClient;
  private toolNameParser: ToolNameParser;
  private defaultMcpName?: string;
  private validitySeconds: number;
  private llm: string;
  private stepIndex: number = 0;

  private currentPlanHash: string | null = null;
  private currentTokenValue: IntentToken | null = null;
  private mcpByAction: Map<string, string> = new Map();

  constructor(client: ArmorIQClient, opts: SessionOptions = {}) {
    this.client = client;
    this.defaultMcpName = opts.defaultMcpName;
    this.toolNameParser =
      opts.toolNameParser ?? defaultToolNameParser(this.defaultMcpName);
    this.validitySeconds = opts.validitySeconds ?? 3600;
    this.llm = opts.llm ?? 'agent';
  }

  /**
   * Capture a plan from the LLM's tool calls and mint an intent token.
   * Idempotent: if called again with the same tool-calls list (by SHA),
   * skips the mint and returns the cached token.
   */
  async startPlan(
    toolCalls: ToolCall[],
    opts: { goal?: string } = {},
  ): Promise<IntentToken> {
    if (toolCalls.length === 0) {
      throw new Error('startPlan called with no tool calls.');
    }

    const hash = hashToolCalls(toolCalls);
    if (this.currentTokenValue && this.currentPlanHash === hash) {
      return this.currentTokenValue;
    }

    const plan = buildPlanFromToolCalls(toolCalls, {
      goal: opts.goal,
      toolNameParser: this.toolNameParser,
      defaultMcpName: this.defaultMcpName,
    });

    this.mcpByAction.clear();
    for (const step of plan.steps as Array<{ action: string; mcp: string }>) {
      this.mcpByAction.set(step.action, step.mcp);
    }

    const planCapture = this.client.capturePlan(this.llm, opts.goal ?? this.llm, plan);
    const token = await this.client.getIntentToken(
      planCapture,
      undefined,
      this.validitySeconds,
    );

    this.currentPlanHash = hash;
    this.currentTokenValue = token;
    this.stepIndex = 0;
    return token;
  }

  /**
   * Check policy for a tool call BEFORE the agent executes it.
   * Calls POST /iap/enforce on the backend.
   * Returns { allowed, action, reason }. The framework plugin uses this
   * to block or let through — the MCP call itself happens on the agent side.
   */
  async enforce(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<EnforceResult> {
    if (!this.currentTokenValue) {
      throw new Error(
        `enforce("${toolName}") called before startPlan().`,
      );
    }

    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;

    try {
      const backendEndpoint = (this.client as any).backendEndpoint;
      const apiKey = (this.client as any).apiKey;

      const response = await axios.post(
        `${backendEndpoint}/iap/enforce`,
        {
          token: this.currentTokenValue.jwtToken || this.currentTokenValue.tokenId,
          plan_id: this.currentTokenValue.planId || this.currentTokenValue.tokenId,
          tool: action,
          mcp: resolvedMcp,
          arguments: toolArgs,
          step_index: this.stepIndex,
        },
        {
          headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      const data = response.data;
      return {
        allowed: data.allowed !== false,
        action: data.action || (data.allowed === false ? 'block' : 'allow'),
        reason: data.reason,
        delegationId: data.delegation_id,
        matchedPolicy: data.matched_policy,
      };
    } catch (err: any) {
      if (err.response?.status === 403) {
        const data = err.response.data || {};
        return {
          allowed: false,
          action: data.action || 'block',
          reason: data.reason || data.message || err.message,
          matchedPolicy: data.matched_policy,
        };
      }
      // On network error or 5xx, fail open with a warning
      console.warn(`[ArmorIQ] enforce() failed: ${err.message}. Allowing tool call.`);
      return { allowed: true, action: 'allow', reason: 'enforce-unavailable' };
    }
  }

  /**
   * Report a tool execution to the audit log AFTER the agent calls the MCP.
   * Calls POST /iap/audit on the backend.
   */
  async report(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: unknown,
    opts: ReportOptions = {},
  ): Promise<void> {
    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;

    try {
      const backendEndpoint = (this.client as any).backendEndpoint;
      const apiKey = (this.client as any).apiKey;
      const token = this.currentTokenValue;

      await axios.post(
        `${backendEndpoint}/iap/audit`,
        {
          token: token?.jwtToken || token?.tokenId || 'unknown',
          plan_id: token?.planId || token?.tokenId || 'unknown',
          step_index: this.stepIndex,
          action,
          tool: action,
          mcp: resolvedMcp,
          input: toolArgs,
          output: typeof result === 'string' ? { text: result } : (result ?? {}),
          status: opts.status || 'success',
          error_message: opts.errorMessage,
          duration_ms: opts.durationMs,
          is_delegated: opts.isDelegated,
          delegated_by: opts.delegatedBy,
          delegated_to: opts.delegatedTo,
          executed_at: new Date().toISOString(),
        },
        {
          headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
    } catch (err: any) {
      console.warn(`[ArmorIQ] report() failed: ${err.message}`);
    }

    this.stepIndex++;
  }

  /**
   * [Proxy mode] Route a tool call through the Armoriq proxy.
   * Returns the raw result so the framework can short-circuit
   * its native dispatch. Use this when the proxy handles the
   * upstream MCP connection (e.g. Claude Desktop, Cursor).
   */
  async dispatch(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.currentTokenValue) {
      throw new Error(
        `dispatch("${toolName}") called before startPlan().`,
      );
    }

    const { mcp, action } = this.toolNameParser(toolName);
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;

    const result: MCPInvocationResult = await this.client.invoke(
      resolvedMcp,
      action,
      this.currentTokenValue,
      toolArgs,
    );
    this.stepIndex++;
    return result.result;
  }

  /** Drop cached plan + token so the next startPlan() always mints fresh. */
  reset(): void {
    this.currentPlanHash = null;
    this.currentTokenValue = null;
    this.mcpByAction.clear();
    this.stepIndex = 0;
  }

  /** Inspect the currently held intent token (for debugging / audit). */
  get currentToken(): IntentToken | null {
    return this.currentTokenValue;
  }
}
