/**
 * Plan-shape helpers used by ArmorIQSession and framework integrations.
 *
 * Most LLM frameworks surface tool calls as a flat list of
 * `{ name, args }`. The SDK accepts that shape directly so plugin code
 * doesn't have to hand-construct `{ goal, steps: [...] }` every time.
 */

import * as crypto from 'crypto';
import { ToolCall } from './models';

export interface ToolNameParser {
  (toolName: string): { mcp: string; action: string };
}

export interface BuildPlanOptions {
  goal?: string;
  toolNameParser?: ToolNameParser;
  defaultMcpName?: string;
}

/**
 * Default tool-name convention: `<MCP>__<action>`. Matches the proxy's
 * MCP gateway and the convention used by sdk-admin-agent.
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

/**
 * Build a SDK-shaped plan dict from a flat list of tool calls.
 */
export function buildPlanFromToolCalls(
  toolCalls: ToolCall[],
  opts: BuildPlanOptions = {},
): Record<string, any> {
  const parser = opts.toolNameParser ?? defaultToolNameParser(opts.defaultMcpName);
  const steps = toolCalls.map((tc) => {
    const { mcp, action } = parser(tc.name);
    return {
      action,
      tool: action,
      mcp,
      params: tc.args ?? {},
      description: `Call ${action} on ${mcp}`,
    };
  });
  return {
    goal: opts.goal ?? 'agent task',
    steps,
  };
}

/**
 * Stable hash over a tool-calls list — used by the session to skip
 * re-minting when the LLM re-emits the same plan in the same turn.
 */
export function hashToolCalls(toolCalls: ToolCall[]): string {
  const canonical = JSON.stringify(
    toolCalls.map((tc) => ({ name: tc.name, args: tc.args ?? {} })),
  );
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
