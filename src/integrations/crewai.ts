/**
 * ArmorIQ — CrewAI integration.
 *
 * Port of armoriq_sdk.integrations.crewai (Python). CrewAI is
 * primarily a Python framework; this TS integration works against the
 * experimental `@crewaijs/crewai` npm port.
 *
 * Pattern (same as Python):
 *   1. Collect every tool from the crew's agents that exposes `.mcp`
 *      and `.action` properties (these are the Armoriq-bound tools).
 *   2. Build a plan and mint an intent token via ArmorIQSession.
 *   3. Patch each tool's `_run` (or `invoke`) to route through the
 *      Armoriq proxy via `session.dispatch`.
 *   4. Restore the originals after kickoff.
 *
 * Usage:
 *
 *   import { ArmorIQCrew } from '@armoriq/sdk-dev/integrations/crewai';
 *
 *   const crew = new ArmorIQCrew({
 *     agents: [...], tasks: [...],
 *     armoriqClient: client,
 *     llm: 'gpt-4o',
 *   });
 *   const result = await crew.kickoff();
 *
 * If `crewai` (the JS port) is not installed, instantiation throws
 * with install instructions — matching the Python behavior.
 */

import { ArmorIQClient } from '../client';
import { ArmorIQSession } from '../session';
import { ToolCall } from '../models';

export interface CrewLikeAgent {
  tools?: Array<CrewLikeTool>;
}

export interface CrewLikeTool {
  mcp?: string;
  action?: string;
  _run?: (...args: any[]) => any;
  invoke?: (...args: any[]) => any;
  name?: string;
}

export interface CrewLikeTask {
  description?: string;
  expected_output?: string;
}

export interface ArmorIQCrewOptions {
  agents: CrewLikeAgent[];
  tasks: CrewLikeTask[];
  /** Any other fields forwarded to the CrewAI Crew constructor. */
  [key: string]: any;

  armoriqClient: ArmorIQClient;
  llm?: string;
  tokenValiditySeconds?: number;
}

function tryRequireCrewai(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('crewai');
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@crewaijs/crewai');
    } catch (err: any) {
      throw new Error(
        'crewai is not installed.\n' +
          'Install a CrewAI JS port: npm install crewai  (or @crewaijs/crewai).\n' +
          `Underlying error: ${err?.message ?? err}`,
      );
    }
  }
}

function collectArmoriqTools(agents: CrewLikeAgent[]): CrewLikeTool[] {
  const seen = new Set<any>();
  const tools: CrewLikeTool[] = [];
  for (const agent of agents) {
    for (const tool of agent?.tools ?? []) {
      if (tool && typeof tool.mcp === 'string' && typeof tool.action === 'string') {
        if (!seen.has(tool)) {
          seen.add(tool);
          tools.push(tool);
        }
      }
    }
  }
  return tools;
}

function buildToolCalls(tools: CrewLikeTool[]): ToolCall[] {
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const t of tools) {
    const key = `${t.mcp}__${t.action}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name: key, args: {} });
    }
  }
  return out;
}

function deriveGoal(tasks: CrewLikeTask[]): string {
  const parts: string[] = [];
  for (const t of tasks) {
    const d = t.description ?? t.expected_output;
    if (d) parts.push(d);
  }
  return parts.length ? parts.join(' ') : 'Execute crew tasks';
}

export class ArmorIQCrew {
  private crew: any;
  private armoriqClient: ArmorIQClient;
  private llm: string;
  private validitySeconds: number;
  private agents: CrewLikeAgent[];
  private tasks: CrewLikeTask[];
  private session: ArmorIQSession | null = null;

  constructor(options: ArmorIQCrewOptions) {
    const crewai = tryRequireCrewai();
    const Crew = crewai.Crew ?? crewai.default?.Crew;
    if (!Crew) {
      throw new Error(
        'The installed crewai package does not export a Crew class.',
      );
    }

    const {
      armoriqClient,
      llm,
      tokenValiditySeconds,
      agents,
      tasks,
      ...rest
    } = options;

    this.armoriqClient = armoriqClient;
    this.llm = llm ?? 'agent';
    this.validitySeconds = tokenValiditySeconds ?? 3600;
    this.agents = agents;
    this.tasks = tasks;
    this.crew = new Crew({ agents, tasks, ...rest });
  }

  private async issueToken(): Promise<ArmorIQSession | null> {
    const tools = collectArmoriqTools(this.agents);
    if (tools.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[ArmorIQCrew] No ArmorIQ tools found; crew runs without ArmorIQ verification.');
      return null;
    }
    const toolCalls = buildToolCalls(tools);
    const session = this.armoriqClient.startSession({
      llm: this.llm,
      validitySeconds: this.validitySeconds,
    });
    await session.startPlan(toolCalls, { goal: deriveGoal(this.tasks) });
    return session;
  }

  private patchTools(session: ArmorIQSession): Array<() => void> {
    const restorers: Array<() => void> = [];
    const patched = new Set<CrewLikeTool>();
    for (const agent of this.agents) {
      for (const tool of agent?.tools ?? []) {
        if (
          !patched.has(tool) &&
          typeof tool.mcp === 'string' &&
          typeof tool.action === 'string'
        ) {
          patched.add(tool);
          const original = tool._run ?? tool.invoke;
          const method: 'invoke' | '_run' = tool.invoke ? 'invoke' : '_run';
          // Use a typed route through Armoriq.
          const wrapped = async (...args: any[]) => {
            const params = (args[0] && typeof args[0] === 'object') ? args[0] : {};
            const result = await session.dispatch(`${tool.mcp}__${tool.action}`, params);
            return typeof result === 'string' ? result : JSON.stringify(result);
          };
          try {
            (tool as any)[method] = wrapped;
          } catch {
            Object.defineProperty(tool, method, { value: wrapped, writable: true });
          }
          restorers.push(() => {
            try {
              (tool as any)[method] = original;
            } catch {
              Object.defineProperty(tool, method, { value: original, writable: true });
            }
          });
        }
      }
    }
    return restorers;
  }

  async kickoff(inputs?: Record<string, any>): Promise<any> {
    this.session = await this.issueToken();
    const restorers = this.session ? this.patchTools(this.session) : [];
    try {
      if (typeof this.crew.kickoff === 'function') {
        return await this.crew.kickoff(inputs);
      }
      throw new Error('The installed crewai Crew has no kickoff() method.');
    } finally {
      for (const r of restorers) r();
    }
  }

  get crewaiCrew(): any {
    return this.crew;
  }
}
