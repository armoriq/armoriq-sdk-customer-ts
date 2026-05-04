/**
 * Plan-shape helpers used by ArmorIQSession and framework integrations.
 *
 * Most LLM frameworks surface tool calls as a flat list of {name, args}.
 * The SDK accepts that shape directly so plugin code doesn't have to
 * hand-construct {goal, steps: [...]} every time.
 *
 * Mirrors armoriq_sdk/plan_builder.py — outputs the same plan shape and
 * hash digest so PY and TS sides round-trip cleanly.
 */

import * as crypto from 'crypto';
import { ToolCall } from './models';

export type ToolNameParser = (toolName: string) => { mcp: string; action: string };

/**
 * Default tool-name convention: `<MCP>__<action>`. Matches the proxy's
 * MCP gateway and the convention used by sdk-admin-agent.
 *
 *   "Stripe__create_payment" -> { mcp: "Stripe", action: "create_payment" }
 *   "create_payment"          -> uses defaultMcpName, else throws.
 */
export function defaultToolNameParser(defaultMcpName?: string): ToolNameParser {
  return (toolName: string) => {
    const idx = toolName.indexOf('__');
    if (idx === -1) {
      if (!defaultMcpName) {
        throw new Error(
          `Tool "${toolName}" is not namespaced as <MCP>__<action> and no defaultMcpName was set on the session.`,
        );
      }
      return { mcp: defaultMcpName, action: toolName };
    }
    const mcp = toolName.slice(0, idx);
    const action = toolName.slice(idx + 2);
    if (!mcp || !action) {
      throw new Error(`Tool "${toolName}" has a malformed MCP prefix.`);
    }
    return { mcp, action };
  };
}

function asToolCall(tc: ToolCall | { name: string; args?: Record<string, unknown> }): ToolCall {
  return { name: tc.name, args: tc.args ?? {} };
}

export interface PlanStep {
  action: string;
  tool: string;
  mcp: string;
  params: Record<string, unknown>;
  description: string;
}

export interface BuiltPlan {
  goal: string;
  steps: PlanStep[];
}

/**
 * Build an SDK-shaped plan dict from a flat list of tool calls.
 */
export function buildPlanFromToolCalls(
  toolCalls: Array<ToolCall | { name: string; args?: Record<string, unknown> }>,
  goal?: string,
  toolNameParser?: ToolNameParser,
  defaultMcpName?: string,
): BuiltPlan {
  const parser = toolNameParser ?? defaultToolNameParser(defaultMcpName);
  const steps: PlanStep[] = toolCalls.map((tc) => {
    const call = asToolCall(tc);
    const { mcp, action } = parser(call.name);
    return {
      action,
      tool: action,
      mcp,
      params: (call.args as Record<string, unknown>) ?? {},
      description: `Call ${action} on ${mcp}`,
    };
  });
  return { goal: goal ?? 'agent task', steps };
}

/**
 * Stable hash over a tool-calls list — used by ArmorIQSession to skip
 * re-minting when the LLM re-emits the same plan in the same turn.
 *
 * Uses JSON.stringify with no key sorting, matching the Python side's
 * json.dumps(separators=(",",":")), so TS and PY produce matching digests.
 */
export function hashToolCalls(
  toolCalls: Array<ToolCall | { name: string; args?: Record<string, unknown> }>,
): string {
  const canonicalList = toolCalls.map((tc) => ({
    name: asToolCall(tc).name,
    args: asToolCall(tc).args ?? {},
  }));
  const canonical = JSON.stringify(canonicalList);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
