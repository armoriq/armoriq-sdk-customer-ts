/**
 * ArmorIQ — Google ADK integration.
 *
 * Wraps the SDK as an ADK `BasePlugin`. Plugin instance is passed to
 * `Runner` (or `InMemoryRunner`) via `plugins: [...]`. End-user agent
 * code is unchanged from a plain ADK setup except for:
 *   1. one extra import
 *   2. one `new ArmorIQADK({ ... })` line
 *   3. passing it into the runner's `plugins` array
 *   4. pointing MCPToolset at the Armoriq proxy URL instead of stdio
 *
 * Usage:
 *
 *   import { LlmAgent, MCPToolset, InMemoryRunner } from '@google/adk';
 *   import { ArmorIQADK } from '@armoriq/sdk-dev/integrations/google-adk';
 *
 *   const armoriq = new ArmorIQADK({ apiKey: API_KEY, proxyUrl: PROXY_URL });
 *
 *   const agent = new LlmAgent({
 *     model: 'gemini-2.5-flash',
 *     name: 'stripe_agent',
 *     instruction: 'You are a Stripe assistant.',
 *     tools: [new MCPToolset({ ... `${PROXY_URL}/mcp/Stripe` ... })],
 *   });
 *
 *   const runner = new InMemoryRunner({ agent, plugins: [armoriq] });
 *
 * Requires: `npm install @google/adk` alongside `@armoriq/sdk`.
 * `@google/adk` is declared as an optional peer dep so users who don't
 * use ADK don't pay for it.
 */

import { ArmorIQClient } from '../client';
import { ArmorIQSession } from '../session';
import { McpCredentialMap, ToolCall } from '../models';
import { ToolNameParser } from '../plan-builder';

// We import @google/adk lazily so consumers who don't use ADK don't
// pay for the dep. The class extends BasePlugin via runtime resolution.
type AnyCtor = new (...args: any[]) => any;

let _BasePluginCache: AnyCtor | null = null;
function loadBasePlugin(): AnyCtor {
  if (_BasePluginCache) return _BasePluginCache;
  try {
    // Try multiple resolution strategies. The SDK is a dependency of
    // the consumer, so `require('@google/adk')` from here resolves in
    // the SDK's own node_modules (where the package isn't installed).
    // We use createRequire from the consumer's working directory so the
    // lookup walks the consumer's node_modules tree instead.
    const { createRequire } = require('module') as typeof import('module');
    const consumerRequire = createRequire(process.cwd() + '/package.json');
    const adk = consumerRequire('@google/adk');
    _BasePluginCache = adk.BasePlugin as AnyCtor;
    if (!_BasePluginCache) {
      throw new Error('@google/adk is installed but does not export BasePlugin.');
    }
    return _BasePluginCache;
  } catch (err: any) {
    throw new Error(
      'ArmorIQADK requires @google/adk to be installed. ' +
        'Install it: npm install @google/adk\n' +
        `Underlying error: ${err?.message ?? err}`,
    );
  }
}

export interface ArmorIQADKOptions {
  /** Pass an existing ArmorIQClient, OR provide apiKey to construct one. */
  client?: ArmorIQClient;
  apiKey?: string;
  proxyUrl?: string;
  userId?: string;
  agentId?: string;
  /** Per-MCP runtime credentials; usually loaded from env automatically. */
  mcpCredentials?: McpCredentialMap;
  /** Used when ADK tool names aren't namespaced as `<MCP>__<action>`. */
  defaultMcpName?: string;
  /** Override the default `<MCP>__<action>` parser. */
  toolNameParser?: ToolNameParser;
  /** LLM identifier recorded on the captured plan (audit only). */
  llm?: string;
  /** Token validity in seconds (default 3600). */
  validitySeconds?: number;
  /** Plugin name for ADK's plugin registry (default 'armoriq'). */
  pluginName?: string;
}

/**
 * Returns a class that extends ADK's `BasePlugin` at runtime, so the
 * SDK doesn't have to import @google/adk at module load.
 */
function buildArmorIQADKClass(): AnyCtor {
  const BasePlugin = loadBasePlugin();

  return class ArmorIQADKImpl extends BasePlugin {
    private armoriqClient: ArmorIQClient;
    // Keyed by invocationId (stable string) rather than object identity,
    // because ADK's afterModelCallback and beforeToolCallback receive
    // different Context object instances for the same invocation.
    private sessions = new Map<string, ArmorIQSession>();
    private opts: ArmorIQADKOptions;

    constructor(opts: ArmorIQADKOptions) {
      super(opts.pluginName ?? 'armoriq');
      this.opts = opts;
      this.armoriqClient =
        opts.client ??
        new ArmorIQClient({
          apiKey: opts.apiKey,
          proxyEndpoint: opts.proxyUrl,
          userId: opts.userId,
          agentId: opts.agentId,
          mcpCredentials: opts.mcpCredentials,
        });
    }

    /**
     * After the model returns: extract function calls, mint an intent
     * token, stash a session keyed off the callbackContext for the
     * matching beforeToolCallback to consume.
     */
    async afterModelCallback(params: {
      callbackContext: any;
      llmResponse: any;
    }): Promise<any> {
      const { callbackContext, llmResponse } = params;
      const parts: any[] = llmResponse?.content?.parts ?? [];
      const toolCalls: ToolCall[] = parts
        .filter((p) => p && p.functionCall && p.functionCall.name)
        .map((p) => ({
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        }));

      if (toolCalls.length === 0) return undefined;

      const session = this.armoriqClient.startSession({
        defaultMcpName: this.opts.defaultMcpName,
        toolNameParser: this.opts.toolNameParser,
        llm: this.opts.llm,
        validitySeconds: this.opts.validitySeconds,
      });

      // ADK's userContent is a Content object ({role, parts}), not a string.
      const rawContent =
        callbackContext?.userContent ??
        callbackContext?.invocationContext?.userContent;
      let goal = 'agent task';
      if (typeof rawContent === 'string') {
        goal = rawContent;
      } else if (rawContent?.parts) {
        const texts = rawContent.parts
          .filter((p: any) => typeof p?.text === 'string')
          .map((p: any) => p.text);
        if (texts.length > 0) goal = texts.join(' ');
      }

      await session.startPlan(toolCalls, { goal });
      const invocationId =
        callbackContext?.invocationContext?.invocationId ??
        callbackContext?.invocationId ??
        'default';
      this.sessions.set(invocationId, session);
      return undefined; // do not modify the LLM response
    }

    /**
     * Before each tool call: enforce policy. If blocked, return an
     * error object (short-circuits the tool). If allowed, return
     * undefined so ADK calls the MCP directly — the agent's own
     * MCPToolset handles the connection with its own credentials.
     */
    async beforeToolCallback(params: {
      tool: any;
      toolArgs: Record<string, unknown>;
      toolContext: any;
    }): Promise<Record<string, unknown> | undefined> {
      const { tool, toolArgs, toolContext } = params;
      const invocationId =
        toolContext?.invocationContext?.invocationId ??
        toolContext?.invocationId ??
        'default';
      const session = this.sessions.get(invocationId);
      if (!session) return undefined;

      const toolName = tool?.name ?? String(tool);
      const decision = await session.enforce(toolName, toolArgs ?? {});

      if (!decision.allowed) {
        // Return an error result to ADK — this short-circuits the tool
        // so the MCP is never called. The LLM sees the block reason.
        return {
          error: `Blocked by ArmorIQ policy: ${decision.reason || decision.action}`,
          enforcement: { action: decision.action, reason: decision.reason },
        };
      }

      // Store start time for duration tracking in afterToolCallback
      (toolContext as any).__armoriq_start = Date.now();
      return undefined; // let ADK call the MCP directly
    }

    /**
     * After each tool call: report execution to audit log.
     * This fires AFTER the MCP returns its result — the agent called
     * the MCP directly, and now we record what happened.
     */
    async afterToolCallback(params: {
      tool: any;
      toolArgs: Record<string, unknown>;
      toolContext: any;
      result: Record<string, unknown>;
    }): Promise<Record<string, unknown> | undefined> {
      const { tool, toolArgs, toolContext, result } = params;
      const invocationId =
        toolContext?.invocationContext?.invocationId ??
        toolContext?.invocationId ??
        'default';
      const session = this.sessions.get(invocationId);
      if (!session) return undefined;

      const toolName = tool?.name ?? String(tool);
      const startTime = (toolContext as any).__armoriq_start;
      const durationMs = startTime ? Date.now() - startTime : undefined;

      const hasError = result?.error || result?.isError;
      await session.report(toolName, toolArgs ?? {}, result, {
        status: hasError ? 'failed' : 'success',
        errorMessage: hasError ? String(result.error || result.isError) : undefined,
        durationMs,
      });

      return undefined; // don't modify the result
    }

    get armoriqSdk(): ArmorIQClient {
      return this.armoriqClient;
    }
  };
}

let _CachedClass: AnyCtor | null = null;

/**
 * Public class. Constructed lazily so importing this module doesn't
 * trigger the @google/adk lookup until the user actually instantiates.
 *
 * Use:
 *   const armoriq = new ArmorIQADK({ apiKey, proxyUrl });
 *   const runner = new InMemoryRunner({ agent, plugins: [armoriq] });
 */
export const ArmorIQADK: new (opts: ArmorIQADKOptions) => any = new Proxy(
  function () {} as any,
  {
    construct(_target, args) {
      if (!_CachedClass) _CachedClass = buildArmorIQADKClass();
      return new _CachedClass(...args);
    },
  },
) as any;
