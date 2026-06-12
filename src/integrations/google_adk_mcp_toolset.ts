/**
 * ArmorIQ — Drop-in replacement for ADK's MCPToolset that routes every
 * tool execution through armoriq-proxy-server instead of fetching the
 * MCP HTTP endpoint directly.
 *
 *     import { MCPToolset } from '@google/adk';
 *     import { ArmorIQMCPToolset } from '@armoriq/sdk-dev/integrations/google_adk_mcp_toolset';
 *
 *     const fhir = new ArmorIQMCPToolset({
 *       mcpName: 'fhir-mcp',
 *       getSession: () => armoriq.currentScope?.session,
 *       client: armoriq.client,
 *       inner: new MCPToolset({ type: 'StreamableHTTPConnectionParams', url: FHIR_MCP_URL }),
 *     });
 *
 *     new LlmAgent({ tools: [fhir], ... });
 *
 * What changes vs. raw MCPToolset:
 *   - Tool discovery (getTools) still hits the real MCP URL via the
 *     wrapped inner instance, so the LLM gets accurate schemas.
 *   - Tool *execution* (runAsync) is rerouted through client.invoke(),
 *     which POSTs to {proxyEndpoint}/invoke. The proxy then runs its
 *     per-call enforcement chain (PAP verify, OPA decision, audit) and
 *     forwards to the upstream MCP server-side — the agent process
 *     never fetches the MCP directly during an LLM-driven tool call.
 */

import type { ArmorIQClient } from '../client';
import type { ArmorIQSession } from '../session';

export interface ArmorIQMCPToolsetOptions {
  /** Name of the MCP server as registered in conmap (e.g. "fhir-mcp"). */
  mcpName: string;
  /** The real ADK MCPToolset instance to wrap. */
  inner: any;
  /** SDK client used to route tool calls through the proxy. */
  client: ArmorIQClient;
  /**
   * Callback returning the current per-request session. Called at
   * runAsync time so the wrapper picks up the intent token minted for
   * the active turn. Return undefined to skip the proxy and fall back
   * to a direct MCP call.
   */
  getSession: () => ArmorIQSession | undefined;
  /**
   * When true, throw if the proxy call can't be made (no session / no
   * token / proxy unreachable). When false (default), fall back to a
   * direct MCP call so the agent stays functional. Set true in prod.
   */
  proxyRequired?: boolean;
}

export class ArmorIQMCPToolset {
  private readonly inner: any;
  private readonly client: ArmorIQClient;
  private readonly mcpName: string;
  private readonly getSession: () => ArmorIQSession | undefined;
  private readonly proxyRequired: boolean;

  // ADK's BaseToolset is detected via a private symbol. Copy any symbol
  // properties off the inner instance so duck-type checks see us as a
  // valid toolset.
  readonly toolFilter: any;
  readonly prefix: any;

  constructor(opts: ArmorIQMCPToolsetOptions) {
    this.inner = opts.inner;
    this.client = opts.client;
    this.mcpName = opts.mcpName;
    this.getSession = opts.getSession;
    this.proxyRequired = opts.proxyRequired ?? false;
    this.toolFilter = this.inner.toolFilter ?? [];
    this.prefix = this.inner.prefix;
    for (const sym of Object.getOwnPropertySymbols(this.inner)) {
      (this as any)[sym] = (this.inner as any)[sym];
    }
  }

  async getTools(context?: any): Promise<any[]> {
    const tools = await this.inner.getTools(context);
    return tools.map((tool: any) => this.wrap(tool));
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  processLlmRequest(toolContext: any, llmRequest: any): Promise<void> | undefined {
    return this.inner.processLlmRequest?.(toolContext, llmRequest);
  }

  private wrap(tool: any): any {
    const client = this.client;
    const mcpName = this.mcpName;
    const proxyRequired = this.proxyRequired;
    const getSession = this.getSession;
    const origRunAsync = tool.runAsync?.bind(tool);

    tool.runAsync = async (request: { args?: Record<string, unknown>; toolContext?: any }) => {
      const session = getSession();
      const intentToken = (session as any)?.currentToken;

      if (session && intentToken) {
        try {
          return await client.invoke(
            mcpName,
            tool.name,
            intentToken,
            request.args ?? {},
          );
        } catch (err) {
          if (proxyRequired || !origRunAsync) throw err;
          console.warn(
            `[armoriq] proxy invoke failed for ${tool.name}: ${(err as Error).message} — falling back to direct MCP call`,
          );
        }
      } else if (proxyRequired) {
        throw new Error(
          `[armoriq] ArmorIQMCPToolset: no active session or intent token for tool ${tool.name}`,
        );
      }
      return origRunAsync ? origRunAsync(request) : undefined;
    };
    return tool;
  }
}
