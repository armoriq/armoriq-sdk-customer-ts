/**
 * ArmorIQ SDK — AWS Strands Agents integration (TypeScript).
 *
 * Mirrors the Python integration and the Google ADK bundle. One factory per
 * process, one plugin per (user, agent). It wires two Strands lifecycle hooks:
 *
 *   AgentInitializedEvent  → capture the agent's tools as the intent plan + mint token
 *   BeforeToolCallEvent    → enforce per-user policy before each tool runs;
 *                            block/hold by setting event.cancel
 *
 * Fail-closed: a tool runs only on an explicit ArmorIQ allow. A block, a hold
 * that is not approved in time, or any enforcement error cancels the tool. The
 * hold path is handled inside session.check() (sdk mode → handleHold → delegation
 * request + approval poll), so HOLD becomes a real approval gate.
 *
 * Strands' TS SDK is duck-typed here (`any`) so this module has no hard
 * dependency on the strands package; attach the plugin via Agent({ plugins: [p] })
 * or p.register(agent).
 *
 * Usage:
 *   const armoriq = new ArmorIQStrands({ client, mode: 'sdk' });
 *   const plugin = await armoriq.forUser('alice@acme.com', { goal: 'reconcile' });
 *   const agent = new Agent({ model, tools, plugins: [plugin] });
 */

import { ArmorIQClient, ArmorIQUserScope } from '../client';
import { ArmorIQSession, SessionOptions } from '../session';
import { ToolNameParser } from '../plan_builder';

export interface ArmorIQStrandsOptions {
  client: ArmorIQClient;
  mode?: SessionOptions['mode'];
  validitySeconds?: number;
  defaultMcpName?: string;
  toolNameParser?: ToolNameParser;
}

export class ArmorIQStrands {
  readonly client: ArmorIQClient;
  readonly mode: SessionOptions['mode'];
  readonly validitySeconds: number;
  readonly defaultMcpName?: string;
  private customParser?: ToolNameParser;
  private _bootstrap?: Record<string, any>;

  constructor(opts: ArmorIQStrandsOptions) {
    this.client = opts.client;
    this.mode = opts.mode ?? 'sdk';
    this.validitySeconds = opts.validitySeconds ?? 3600;
    this.defaultMcpName = opts.defaultMcpName;
    this.customParser = opts.toolNameParser;
  }

  async bootstrap(): Promise<Record<string, any>> {
    if (!this._bootstrap) this._bootstrap = await this.client.bootstrap();
    return this._bootstrap;
  }

  async toolNameParser(): Promise<ToolNameParser> {
    if (this.customParser) return this.customParser;
    const toolMap: Record<string, string> = (await this.bootstrap()).toolMap ?? {};
    const defaultMcp = this.defaultMcpName ?? 'unknown';
    return (toolName: string) => {
      const mcp = toolMap[toolName];
      if (mcp) return { mcp, action: toolName };
      if (toolName.includes('__')) {
        const [prefix, ...rest] = toolName.split('__');
        return { mcp: prefix, action: rest.join('__') };
      }
      return { mcp: defaultMcp, action: toolName };
    };
  }

  invalidateUser(userEmail: string): void {
    this.client.invalidateUser(userEmail);
  }

  async forUser(
    userEmail: string,
    opts?: { goal?: string },
  ): Promise<ArmorIQStrandsPlugin> {
    const scope = this.client.forUser(userEmail);
    return new ArmorIQStrandsPlugin({
      factory: this,
      scope,
      userEmail: userEmail.trim().toLowerCase(),
      goal: opts?.goal,
      parser: await this.toolNameParser(),
    });
  }
}

export class ArmorIQStrandsPlugin {
  private factory: ArmorIQStrands;
  private scope: ArmorIQUserScope;
  private userEmail: string;
  private goal?: string;
  private parser: ToolNameParser;
  private session?: ArmorIQSession;
  private planStarted = false;

  constructor(args: {
    factory: ArmorIQStrands;
    scope: ArmorIQUserScope;
    userEmail: string;
    goal?: string;
    parser: ToolNameParser;
  }) {
    this.factory = args.factory;
    this.scope = args.scope;
    this.userEmail = args.userEmail;
    this.goal = args.goal;
    this.parser = args.parser;
  }

  /** Strands Plugin entrypoint: register our hooks on the agent. */
  initAgent(agent: any): void {
    this.register(agent);
  }

  /** Wire the BeforeToolCall + AgentInitialized hooks onto a Strands agent. */
  register(agent: any): void {
    const add = (agent.addHook ?? agent.hooks?.addCallback)?.bind(
      agent.addHook ? agent : agent.hooks,
    );
    if (!add) {
      throw new Error('ArmorIQStrands: agent has no addHook/hooks.addCallback');
    }
    add('AgentInitializedEvent', (e: any) => this.onAgentInitialized(e));
    add('BeforeToolCallEvent', (e: any) => this.beforeToolCall(e));
  }

  private ensureSession(): ArmorIQSession {
    if (!this.session) {
      this.session = this.scope.startSession({
        mode: this.factory.mode,
        validitySeconds: this.factory.validitySeconds,
        toolNameParser: this.parser,
        defaultMcpName: this.factory.defaultMcpName,
      });
    }
    return this.session;
  }

  private async startPlan(agent: any): Promise<void> {
    if (this.planStarted) return;
    const toolNames: string[] = agent?.toolNames ?? agent?.tool_names ?? [];
    if (!toolNames.length) return;
    const toolCalls = toolNames.map((name) => ({ name, args: {} }));
    await this.ensureSession().startPlan(toolCalls, this.goal);
    this.planStarted = true;
  }

  private async onAgentInitialized(event: any): Promise<void> {
    try {
      await this.startPlan(event?.agent);
    } catch (exc) {
      console.warn(`[armoriq] strands plan capture failed: ${(exc as Error).message}`);
    }
  }

  private async beforeToolCall(event: any): Promise<void> {
    const toolUse = event?.toolUse ?? event?.tool_use ?? {};
    const toolName: string = toolUse.name ?? '';
    const args = toolUse.input ?? {};
    try {
      if (!this.planStarted) await this.startPlan(event?.agent);
      const decision = await this.ensureSession().check(toolName, args, this.userEmail);
      if (!decision.allowed) {
        const reason = decision.reason ?? 'blocked by policy';
        event.cancel = `ArmorIQ ${decision.action}: ${reason}`;
      }
    } catch (exc) {
      // Fail closed: never let a tool run if enforcement errored.
      event.cancel = `ArmorIQ enforcement error (fail-closed): ${(exc as Error).message}`;
    }
  }
}
