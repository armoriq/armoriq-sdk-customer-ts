/**
 * Token-usage capture — shared across all ArmorIQ tool integrations
 * (ArmorClaude / ArmorCodex / ArmorCopilot / future agents).
 *
 * The transport (`ArmorIQClient.recordTokenUsage`) is the single code path every
 * tool posts through. `summarizeTranscriptUsage` parses an Anthropic-style JSONL
 * transcript (Claude Code / Codex CLI) into per-model entries; tools whose
 * transcript differs can build entries themselves and still post via the client.
 */
import { readFileSync } from 'fs';

export interface TokenUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RecordTokenUsagePayload {
  /** Product slug: "armorclaude" | "armorcodex" | "armorcopilot" | ... */
  product: string;
  sessionId: string;
  entries: TokenUsageEntry[];
}

/**
 * Parse a JSONL transcript (one JSON object per line) and sum LLM token usage by
 * model. Each assistant line is expected to carry `message.usage` with
 * `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, and `message.model`. Synthetic and zero-usage
 * lines are skipped. Pure + defensive: returns [] on any read/parse error.
 */
export function summarizeTranscriptUsage(transcriptPath: string): TokenUsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const byModel = new Map<string, TokenUsageEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Tolerate both Anthropic (Claude Code) and OpenAI (Codex CLI) shapes, and
    // common nestings (top-level, message.*, payload.*).
    const msg = obj?.message ?? obj?.payload ?? obj;
    const usage = msg?.usage ?? obj?.usage;
    const model: string =
      typeof msg?.model === 'string' ? msg.model : typeof obj?.model === 'string' ? obj.model : '';
    if (!usage || !model || model === '<synthetic>') continue;
    // Anthropic: input_tokens/output_tokens; OpenAI: prompt_tokens/completion_tokens.
    const inTok = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
    const outTok = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
    const cacheRead =
      Number(usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    if (inTok + outTok + cacheRead + cacheWrite === 0) continue;
    const acc =
      byModel.get(model) ||
      ({
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      } as TokenUsageEntry);
    acc.inputTokens += inTok;
    acc.outputTokens += outTok;
    acc.cacheReadTokens += cacheRead;
    acc.cacheWriteTokens += cacheWrite;
    byModel.set(model, acc);
  }
  return [...byModel.values()];
}
