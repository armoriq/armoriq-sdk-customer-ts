/**
 * ArmorIQSession — collapses the four-step framework-integration
 * pattern into two calls.
 *
 *   await session.startPlan(toolCalls)        // capture plan + mint token
 *   return session.dispatch(toolName, args)   // route through proxy
 *
 * Each framework adapter (ADK, LangChain, OpenAI Agents, Vercel AI
 * SDK, etc.) wires its own hooks into these two methods and never has
 * to think about plan shape, token threading, or cred-mode handling.
 */

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

export class ArmorIQSession {
  private client: ArmorIQClient;
  private toolNameParser: ToolNameParser;
  private defaultMcpName?: string;
  private validitySeconds: number;
  private llm: string;

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

    // Remember each action's MCP so dispatch() can resolve it without
    // re-parsing the framework's tool name (which may differ).
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
    return token;
  }

  /**
   * Route a tool call through the Armoriq proxy.
   * Returns the raw `result` field so the framework can short-circuit
   * its native dispatch by returning this value directly.
   */
  async dispatch(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.currentTokenValue) {
      throw new Error(
        `dispatch("${toolName}") called before startPlan(). ` +
          'Call startPlan(toolCalls) in your after-model hook first.',
      );
    }

    const { mcp, action } = this.toolNameParser(toolName);
    // Prefer the MCP recorded at plan-capture time when available — this
    // covers cases where the framework hands us a slightly different
    // tool name shape than what we parsed off the LLM response.
    const resolvedMcp = this.mcpByAction.get(action) ?? mcp;

    const result: MCPInvocationResult = await this.client.invoke(
      resolvedMcp,
      action,
      this.currentTokenValue,
      toolArgs,
    );
    return result.result;
  }

  /** Drop cached plan + token so the next startPlan() always mints fresh. */
  reset(): void {
    this.currentPlanHash = null;
    this.currentTokenValue = null;
    this.mcpByAction.clear();
  }

  /** Inspect the currently held intent token (for debugging / audit). */
  get currentToken(): IntentToken | null {
    return this.currentTokenValue;
  }
}
