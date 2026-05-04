/**
 * ArmorIQ — Google ADK integration (TypeScript).
 *
 * Mirrors armoriq_sdk/integrations/google_adk.py.
 *
 * Multi-user pattern:
 *
 *     import { ArmorIQADK } from '@armoriq/sdk/integrations/google_adk';
 *     const armoriq = new ArmorIQADK({ apiKey: process.env.ARMORIQ_API_KEY! });
 *
 *     // per-request, inside your chat handler:
 *     const scope = await armoriq.forUser(userEmail, { goal: message });
 *     scope.install(rootAgent);
 *     try {
 *       for await (const event of runner.runAsync(...)) { ... }
 *     } finally {
 *       scope.uninstall(rootAgent);
 *     }
 *
 * The bundle installs three ADK lifecycle callbacks on the agent:
 *   afterModelCallback  → mint intent token from LLM tool calls
 *   beforeToolCallback  → enforce per-user policy, block/hold if needed
 *   afterToolCallback   → audit report
 *
 * "Agent" here is duck-typed — anything with three settable callback
 * properties works. We don't take a hard dep on a specific TS ADK
 * package because there isn't a single dominant one yet; the contract
 * is a bag of three async functions.
 */

import { ArmorIQClient, ArmorIQUserScope } from '../client';
import { ToolCall } from '../models';
import {
  ArmorIQSession,
  ReportOptions,
  SessionMode,
  SessionOptions,
} from '../session';
import { ToolNameParser } from '../plan_builder';

export interface ArmorIQADKOptions {
  apiKey: string;
  backendEndpoint?: string;
  iapEndpoint?: string;
  proxyEndpoint?: string;
  useProduction?: boolean;
  defaultMcpName?: string;
  toolNameParser?: ToolNameParser;
  validitySeconds?: number;
  mode?: SessionMode;
  llm?: string;
}

/**
 * The minimal agent shape we need: three settable callback slots.
 * Mirrors what google-adk-python expects on its Agent class.
 */
export interface AdkLikeAgent {
  afterModelCallback?: (...args: any[]) => Promise<unknown> | unknown;
  beforeToolCallback?: (tool: any, args: any, ctx?: any) => Promise<unknown> | unknown;
  afterToolCallback?: (tool: any, args: any, ctx?: any, response?: any) => Promise<unknown> | unknown;
}

/**
 * Process-wide ArmorIQ factory for ADK-style agents.
 */
export class ArmorIQADK {
  public readonly client: ArmorIQClient;
  public readonly mode: SessionMode;
  public readonly llm: string;
  public readonly validitySeconds: number;
  public readonly defaultMcpName?: string;
  private customParser?: ToolNameParser;
  private bootstrapData?: Record<string, any>;

  constructor(opts: ArmorIQADKOptions) {
    this.client = new ArmorIQClient({
      apiKey: opts.apiKey,
      backendEndpoint: opts.backendEndpoint,
      iapEndpoint: opts.iapEndpoint ?? opts.backendEndpoint,
      proxyEndpoint: opts.proxyEndpoint ?? opts.backendEndpoint,
      useProduction: opts.useProduction ?? true,
      userId: 'agent',
      agentId: 'agent',
    });
    this.defaultMcpName = opts.defaultMcpName;
    this.customParser = opts.toolNameParser;
    this.validitySeconds = opts.validitySeconds ?? 300;
    this.mode = opts.mode ?? 'sdk';
    this.llm = opts.llm ?? 'agent';
  }

  async bootstrap(): Promise<Record<string, any>> {
    if (!this.bootstrapData) {
      this.bootstrapData = await this.client.bootstrap();
      const orgName = this.bootstrapData.org?.name ?? 'unknown';
      const mcps = Array.isArray(this.bootstrapData.mcps)
        ? this.bootstrapData.mcps.map((m: any) => m.name)
        : [];
      const toolMapSize = Object.keys(this.bootstrapData.toolMap ?? {}).length;
      console.info(
        `[armoriq] bootstrap: org=${orgName} mcps=${JSON.stringify(mcps)} toolMap=${toolMapSize}`,
      );
    }
    return this.bootstrapData!;
  }

  private async toolNameParser(): Promise<ToolNameParser> {
    if (this.customParser) return this.customParser;
    const bootstrap = await this.bootstrap();
    const toolMap: Record<string, string> = bootstrap.toolMap ?? {};
    const defaultMcp = this.defaultMcpName;
    return (toolName: string) => {
      const mcp = toolMap[toolName];
      if (mcp) return { mcp, action: toolName };
      if (toolName.includes('__')) {
        const idx = toolName.indexOf('__');
        return { mcp: toolName.slice(0, idx), action: toolName.slice(idx + 2) };
      }
      if (defaultMcp) return { mcp: defaultMcp, action: toolName };
      return { mcp: 'unknown', action: toolName };
    };
  }

  invalidateUser(userEmail: string): void {
    this.client.invalidateUser(userEmail);
  }

  async forUser(userEmail: string, opts?: { goal?: string }): Promise<ArmorIQADKBundle> {
    await this.bootstrap();
    const scope: ArmorIQUserScope = this.client.forUser(userEmail);
    const parser = await this.toolNameParser();
    return new ArmorIQADKBundle({
      factory: this,
      scope,
      parser,
      userEmail: userEmail.trim().toLowerCase(),
      goal: opts?.goal ?? 'agent task',
    });
  }
}

/**
 * Per-request ADK bundle — installs/uninstalls lifecycle callbacks on
 * one agent and binds them to one user's session.
 */
export class ArmorIQADKBundle {
  public readonly userEmail: string;
  public readonly goal: string;
  public session?: ArmorIQSession;
  private factory: ArmorIQADK;
  private scope: ArmorIQUserScope;
  private parser: ToolNameParser;
  private planMinted = false;
  private blockedTools = new Set<string>();
  private blockedActions = new Map<string, string>();
  private agent?: AdkLikeAgent;
  private saved: {
    afterModelCallback?: AdkLikeAgent['afterModelCallback'];
    beforeToolCallback?: AdkLikeAgent['beforeToolCallback'];
    afterToolCallback?: AdkLikeAgent['afterToolCallback'];
  } = {};

  constructor(args: {
    factory: ArmorIQADK;
    scope: ArmorIQUserScope;
    parser: ToolNameParser;
    userEmail: string;
    goal: string;
  }) {
    this.factory = args.factory;
    this.scope = args.scope;
    this.parser = args.parser;
    this.userEmail = args.userEmail;
    this.goal = args.goal;
  }

  private ensureSession(): ArmorIQSession {
    if (!this.session) {
      const opts: SessionOptions = {
        mode: this.factory.mode,
        validitySeconds: this.factory.validitySeconds,
        llm: this.factory.llm,
        toolNameParser: this.parser,
        defaultMcpName: this.factory.defaultMcpName,
      };
      this.session = this.scope.startSession(opts);
    }
    return this.session;
  }

  private async afterModel(_callbackContext: any, llmResponse: any): Promise<unknown> {
    try {
      if (this.planMinted) return null;
      const parts = llmResponse?.content?.parts ?? [];
      const toolCalls: ToolCall[] = [];
      for (const p of parts) {
        const fc = p?.functionCall ?? p?.function_call;
        if (fc?.name) {
          toolCalls.push({ name: fc.name, args: fc.args ? { ...fc.args } : {} });
        }
      }
      if (toolCalls.length === 0) return null;
      await this.ensureSession().startPlan(toolCalls, this.goal);
      this.planMinted = true;
      console.info(`[armoriq] plan minted user=${this.userEmail} tools=${toolCalls.length}`);
    } catch (exc) {
      console.warn(`[armoriq] afterModelCallback failed: ${(exc as Error).message}`);
    }
    return null;
  }

  private async beforeTool(tool: any, args: any, _toolContext?: any): Promise<unknown> {
    const toolName: string = tool?.name ?? String(tool);
    try {
      const decision = await this.ensureSession().check(toolName, args ?? {}, this.userEmail);
      if (!decision.allowed) {
        const policy = decision.matchedPolicy ? ` (policy: ${decision.matchedPolicy})` : '';

        if (decision.action === 'hold') {
          console.info(
            `[armoriq] HELD ${toolName} user=${this.userEmail} reason=${decision.reason} — waiting for approval...`,
          );
          // 30-min default, 3s → 15s exponential, matches PY hold-retry.
          const timeoutMs = 30 * 60 * 1000;
          const deadline = Date.now() + timeoutMs;
          let pollIntervalMs = 3000;
          let attempt = 0;
          let approved = false;
          let finalDecision = decision;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            pollIntervalMs = Math.min(pollIntervalMs * 1.5, 15000);
            attempt += 1;
            const retry = await this.ensureSession().check(
              toolName,
              args ?? {},
              this.userEmail,
            );
            finalDecision = retry;
            if (retry.allowed) {
              console.info(`[armoriq] APPROVED ${toolName} attempt ${attempt}`);
              approved = true;
              break;
            }
            if (retry.action !== 'hold') {
              console.info(`[armoriq] REJECTED ${toolName} action=${retry.action}`);
              break;
            }
          }

          if (approved) return null;

          const finalPolicy = finalDecision.matchedPolicy
            ? ` (policy: ${finalDecision.matchedPolicy})`
            : '';
          this.blockedTools.add(toolName);
          this.blockedActions.set(toolName, finalDecision.action);
          if (finalDecision.action === 'hold') {
            return {
              error: `Approval timed out${finalPolicy}. Reason: ${finalDecision.reason ?? 'policy-hold'}.`,
              armoriq_enforcement: {
                blocked: true,
                action: 'hold',
                reason: finalDecision.reason,
                matched_policy: finalDecision.matchedPolicy,
                tool: toolName,
                delegation_id: finalDecision.delegationId,
              },
            };
          }
          return {
            error: `This action is not permitted${finalPolicy}. Reason: ${finalDecision.reason ?? 'policy-blocked'}.`,
            armoriq_enforcement: {
              blocked: true,
              action: finalDecision.action,
              reason: finalDecision.reason,
              matched_policy: finalDecision.matchedPolicy,
              tool: toolName,
              delegation_id: finalDecision.delegationId,
            },
          };
        }

        // Hard block
        this.blockedTools.add(toolName);
        this.blockedActions.set(toolName, decision.action);
        console.info(
          `[armoriq] BLOCKED ${toolName} user=${this.userEmail} action=${decision.action} reason=${decision.reason}`,
        );
        return {
          error: `This action is not permitted by your organization's policy${policy}. Reason: ${decision.reason ?? 'policy-blocked'}.`,
          armoriq_enforcement: {
            blocked: true,
            action: decision.action,
            reason: decision.reason,
            matched_policy: decision.matchedPolicy,
            tool: toolName,
            delegation_id: decision.delegationId,
          },
        };
      }
    } catch (exc) {
      console.warn(`[armoriq] beforeToolCallback failed: ${(exc as Error).message}`);
    }
    return null;
  }

  private async afterTool(tool: any, args: any, _toolContext: any, toolResponse: any): Promise<unknown> {
    const toolName: string = tool?.name ?? String(tool);
    try {
      if (this.blockedTools.has(toolName)) {
        const action = this.blockedActions.get(toolName) ?? 'block';
        this.blockedActions.delete(toolName);
        this.blockedTools.delete(toolName);
        if (action !== 'hold') {
          await this.ensureSession().report(toolName, args ?? {}, toolResponse, {
            status: 'failed',
            errorMessage: 'Blocked by policy',
          } as ReportOptions);
        }
        return null;
      }
      await this.ensureSession().report(toolName, args ?? {}, toolResponse);
    } catch (exc) {
      console.warn(`[armoriq] afterToolCallback failed: ${(exc as Error).message}`);
    }
    return null;
  }

  /**
   * Attach the three callbacks to the ADK-style agent. Save originals
   * for uninstall().
   */
  install(agent: AdkLikeAgent): this {
    this.agent = agent;
    this.saved = {
      afterModelCallback: agent.afterModelCallback,
      beforeToolCallback: agent.beforeToolCallback,
      afterToolCallback: agent.afterToolCallback,
    };
    agent.afterModelCallback = (...args: any[]) => this.afterModel(args[0], args[1]);
    agent.beforeToolCallback = (...args: any[]) => {
      const a = args[0];
      // Require `tool` specifically — anything else means we're in legacy
      // positional mode and a is the BaseTool itself.
      if (a && typeof a === 'object' && 'tool' in a) {
        return this.beforeTool(a.tool, a.args, a.context ?? a.toolContext);
      }
      return this.beforeTool(a, args[1], args[2]);
    };
    agent.afterToolCallback = (...args: any[]) => {
      const a = args[0];
      // Require `tool` specifically — anything else means we're in legacy
      // positional mode and a is the BaseTool itself.
      if (a && typeof a === 'object' && 'tool' in a) {
        return this.afterTool(a.tool, a.args, a.context ?? a.toolContext, a.response);
      }
      return this.afterTool(a, args[1], args[2], args[3]);
    };
    return this;
  }

  uninstall(agent?: AdkLikeAgent): void {
    const a = agent ?? this.agent;
    if (!a) return;
    a.afterModelCallback = this.saved.afterModelCallback;
    a.beforeToolCallback = this.saved.beforeToolCallback;
    a.afterToolCallback = this.saved.afterToolCallback;
  }
}
