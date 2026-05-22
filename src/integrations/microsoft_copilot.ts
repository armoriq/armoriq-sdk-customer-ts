/**
 * ArmorIQ - Microsoft Copilot Studio integration (TypeScript).
 *
 * Provides the building blocks for hosting an ArmorCopilot webhook
 * receiver that fronts the Microsoft Copilot Studio external security
 * webhook (`POST /analyze-tool-execution`).
 *
 *   import {
 *     verifyCopilotStudioSignature,
 *     translateCopilotStudioPayload,
 *   } from '@armoriq/sdk/integrations/microsoft_copilot';
 *
 * The MS side sends each tool invocation with an HMAC-SHA256 signature
 * computed over `<timestamp>.<rawBody>` using a shared secret the tenant
 * configured in Copilot Studio admin. We verify, translate the payload
 * to our internal tool-call shape, then run the request through
 * ArmorIQ policy enforcement.
 *
 * The verifier here is pure crypto: it does not call the backend. The
 * caller is responsible for routing the verified request through the
 * regular SDK enforce path (or future plan-less enforce endpoint) once
 * the signature has been confirmed.
 */

import * as crypto from 'crypto';

const MAX_SKEW_SECONDS = 300;

export interface CopilotStudioPayload {
  userMessage?: string;
  chatHistory?: Record<string, unknown>;
  toolDefinition: {
    name?: string;
    id?: string;
    description?: string;
    [key: string]: unknown;
  };
  toolInputValues?: Record<string, unknown>;
  agentMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
  conversationMetadata?: Record<string, unknown>;
}

export interface CopilotStudioVerifyArgs {
  /** Raw HTTP body bytes — must be the exact bytes MS signed, before any JSON re-serialization. */
  rawBody: Buffer | string;
  /** Value of `X-ArmorCopilot-Signature` header. Hex string, optionally prefixed `sha256=`. */
  signature: string;
  /** Value of `X-ArmorCopilot-Timestamp` header. Unix seconds. */
  timestamp: string | number;
  /** Per-tenant shared secret configured in Copilot Studio admin. */
  secret: string;
  /** Maximum allowed clock skew in seconds. Defaults to 300 (5 min). */
  maxSkewSeconds?: number;
}

export interface CopilotStudioVerifyResult {
  ok: boolean;
  reason?:
    | 'missing-signature'
    | 'missing-timestamp'
    | 'invalid-timestamp'
    | 'timestamp-skew'
    | 'bad-signature';
}

/**
 * Verify the HMAC signature MS Copilot Studio attaches to a webhook
 * request. Pure crypto — no backend calls. Constant-time comparison.
 */
export function verifyCopilotStudioSignature(
  args: CopilotStudioVerifyArgs,
): CopilotStudioVerifyResult {
  if (!args.signature) return { ok: false, reason: 'missing-signature' };
  if (args.timestamp === undefined || args.timestamp === null) {
    return { ok: false, reason: 'missing-timestamp' };
  }

  const tsNum =
    typeof args.timestamp === 'number'
      ? args.timestamp
      : Number(args.timestamp);
  if (Number.isNaN(tsNum)) {
    return { ok: false, reason: 'invalid-timestamp' };
  }

  const drift = Math.abs(Date.now() / 1000 - tsNum);
  const maxSkew = args.maxSkewSeconds ?? MAX_SKEW_SECONDS;
  if (drift > maxSkew) return { ok: false, reason: 'timestamp-skew' };

  const body =
    typeof args.rawBody === 'string'
      ? args.rawBody
      : args.rawBody.toString('utf8');
  const expected = crypto
    .createHmac('sha256', args.secret)
    .update(`${tsNum}.${body}`)
    .digest('hex');

  const provided = args.signature.startsWith('sha256=')
    ? args.signature.slice(7)
    : args.signature;

  if (provided.length !== expected.length) {
    return { ok: false, reason: 'bad-signature' };
  }
  const match = crypto.timingSafeEqual(
    Buffer.from(provided, 'hex'),
    Buffer.from(expected, 'hex'),
  );
  return match ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

export interface TranslatedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  userMessage?: string;
  agentMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
  conversationMetadata?: Record<string, unknown>;
}

/**
 * Translate a Copilot Studio webhook payload into the
 * `{ toolName, args, ...meta }` shape ArmorIQ enforce paths expect.
 */
export function translateCopilotStudioPayload(
  payload: CopilotStudioPayload,
): TranslatedToolCall {
  const toolName =
    payload.toolDefinition?.name ??
    payload.toolDefinition?.id ??
    'unknown';
  return {
    toolName: String(toolName),
    args: payload.toolInputValues ?? {},
    userMessage: payload.userMessage,
    agentMetadata: payload.agentMetadata,
    userMetadata: payload.userMetadata,
    conversationMetadata: payload.conversationMetadata,
  };
}

export interface CopilotStudioDecision {
  action: 'allow' | 'block';
  reason?: string;
}

/**
 * Sentinel mapping: a non-allow enforce result -> Copilot Studio response.
 */
export function toCopilotStudioDecision(
  enforced: { allowed: boolean; action?: string; reason?: string },
): CopilotStudioDecision {
  if (enforced.allowed && enforced.action !== 'block') {
    return { action: 'allow' };
  }
  return { action: 'block', reason: enforced.reason };
}
