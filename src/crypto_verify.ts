import * as crypto from 'crypto';

// Canonical JSON that byte-for-byte matches the IAP signer's
// json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).
// Used to recompute the exact bytes an Ed25519 intent-token signature covers.

function escapeAsciiString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('non-finite number is not valid in canonical JSON');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return escapeAsciiString(value as string);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => escapeAsciiString(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`unsupported type in canonical JSON: ${t}`);
}

// Verify the Ed25519 signature of an intent token (the csrg token dict stored
// under rawToken.token), over the exact canonical payload the IAP signed.
// Returns false on missing material or a bad signature. Does NOT check expiry.
export function verifyIntentTokenSignature(rawToken: any): boolean {
  const tokenData = (rawToken && rawToken.token) || {};
  const publicKeyHex = tokenData.public_key;
  const signatureHex = tokenData.signature;
  if (!publicKeyHex || !signatureHex || !tokenData.plan_hash) return false;
  const payload: Record<string, unknown> = {
    plan_hash: tokenData.plan_hash,
    issued_at: tokenData.issued_at,
    expires_at: tokenData.expires_at,
    policy: tokenData.policy,
    identity: tokenData.identity,
    public_key: tokenData.public_key,
    version: tokenData.version,
  };
  if (tokenData.allowed_operations) payload.allowed_operations = tokenData.allowed_operations;
  if (tokenData.resource_scope) payload.resource_scope = tokenData.resource_scope;
  return verifyEd25519(publicKeyHex, Buffer.from(canonicalJson(payload), 'utf8'), signatureHex);
}

// Verify a raw Ed25519 signature (hex) over `message` using a raw 32-byte
// Ed25519 public key (hex). Wraps the key in the standard SPKI DER prefix so
// Node's crypto.verify accepts it. Returns false on any malformed input.
export function verifyEd25519(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  try {
    const rawKey = Buffer.from(publicKeyHex, 'hex');
    if (rawKey.length !== 32) return false;
    const sig = Buffer.from(signatureHex, 'hex');
    if (sig.length !== 64) return false;
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, message, keyObject, sig);
  } catch {
    return false;
  }
}
