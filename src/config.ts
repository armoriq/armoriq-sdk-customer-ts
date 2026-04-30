/**
 * armoriq.yaml configuration models and loader.
 *
 * Mirrors armoriq_sdk/config.py shape so the same file is portable
 * between the two SDKs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export const DEFAULT_PROXY_URL = 'https://customer-proxy.armoriq.ai';

export class ArmorIQConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArmorIQConfigError';
  }
}

/**
 * Resolve `$ENV_VAR` or `${ENV_VAR}` references against process.env.
 * Returns the original string when it is not an env reference.
 */
export function resolveEnvReference(value: string): string {
  if (typeof value !== 'string') return value;
  if (value.startsWith('${') && value.endsWith('}')) {
    return process.env[value.slice(2, -1)] ?? '';
  }
  if (value.startsWith('$') && value.length > 1 && !value.includes(' ')) {
    return process.env[value.slice(1)] ?? '';
  }
  return value;
}

export interface IdentityConfig {
  api_key: string;
  user_id: string;
  agent_id: string;
}

export interface ProxyConfig {
  url: string;
  timeout: number;
  max_retries: number;
}

export type MCPAuthType = 'none' | 'bearer' | 'api_key';

export interface MCPAuthConfig {
  type: MCPAuthType;
  token?: string;
  api_key?: string;
}

export interface MCPServerConfig {
  id: string;
  url: string;
  description?: string;
  auth: MCPAuthConfig;
}

export interface PolicyConfig {
  allow: string[];
  deny: string[];
}

export interface IntentConfig {
  ttl_seconds: number;
  require_csrg: boolean;
}

export type Environment = 'sandbox' | 'production';

export interface ArmorIQConfig {
  version: 'v1';
  identity: IdentityConfig;
  environment: Environment;
  proxy: ProxyConfig;
  mcp_servers: MCPServerConfig[];
  policy: PolicyConfig;
  intent: IntentConfig;
}

function normalizeAuth(value: unknown): MCPAuthConfig {
  if (value === null || value === undefined) return { type: 'none' };
  if (typeof value === 'string') return { type: value as MCPAuthType };
  return value as MCPAuthConfig;
}

function validateIdentity(raw: any): IdentityConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ArmorIQConfigError('identity is required');
  }
  for (const k of ['api_key', 'user_id', 'agent_id']) {
    if (typeof raw[k] !== 'string' || !raw[k]) {
      throw new ArmorIQConfigError(`identity.${k} is required`);
    }
  }
  return { api_key: raw.api_key, user_id: raw.user_id, agent_id: raw.agent_id };
}

function validateAuth(raw: any): MCPAuthConfig {
  const a = normalizeAuth(raw);
  if (a.type === 'bearer' && !a.token) {
    throw new ArmorIQConfigError("bearer auth requires 'token'");
  }
  if (a.type === 'api_key' && !a.api_key) {
    throw new ArmorIQConfigError("api_key auth requires 'api_key'");
  }
  if (a.type !== 'bearer' && a.type !== 'api_key' && a.type !== 'none') {
    throw new ArmorIQConfigError(`unknown auth type: ${a.type}`);
  }
  return a;
}

export function parseArmorIQConfig(raw: any): ArmorIQConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ArmorIQConfigError('config root must be an object');
  }
  const version = raw.version ?? 'v1';
  if (version !== 'v1') {
    throw new ArmorIQConfigError(`unsupported config version: ${version}`);
  }
  const environment = raw.environment ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new ArmorIQConfigError(`environment must be sandbox or production, got: ${environment}`);
  }

  const proxy: ProxyConfig = {
    url: raw.proxy?.url ?? DEFAULT_PROXY_URL,
    timeout: raw.proxy?.timeout ?? 30,
    max_retries: raw.proxy?.max_retries ?? 3,
  };

  const policy: PolicyConfig = {
    allow: Array.isArray(raw.policy?.allow) ? raw.policy.allow : [],
    deny: Array.isArray(raw.policy?.deny) ? raw.policy.deny : [],
  };

  const intent: IntentConfig = {
    ttl_seconds: raw.intent?.ttl_seconds ?? 300,
    require_csrg: raw.intent?.require_csrg ?? true,
  };

  const mcpServersRaw: any[] = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  const mcpServers: MCPServerConfig[] = mcpServersRaw.map((s, i) => {
    if (!s.id || typeof s.id !== 'string') {
      throw new ArmorIQConfigError(`mcp_servers[${i}].id is required`);
    }
    if (!s.url || typeof s.url !== 'string') {
      throw new ArmorIQConfigError(`mcp_servers[${i}].url is required`);
    }
    return {
      id: s.id,
      url: s.url,
      description: s.description,
      auth: validateAuth(s.auth),
    };
  });
  const ids = mcpServers.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    throw new ArmorIQConfigError("mcp_servers contain duplicate 'id' values");
  }

  return {
    version: 'v1',
    identity: validateIdentity(raw.identity),
    environment,
    proxy,
    mcp_servers: mcpServers,
    policy,
    intent,
  };
}

export function loadArmorIQConfig(filePath: string = 'armoriq.yaml'): ArmorIQConfig {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new ArmorIQConfigError(`Config file not found: ${resolved}`);
  }
  const raw = yaml.load(fs.readFileSync(resolved, 'utf-8')) ?? {};
  return parseArmorIQConfig(raw);
}

/**
 * Resolve every `$VAR` reference in the config against process.env.
 * Returns a new config with the references replaced by their values.
 */
export function resolveEnvReferences(config: ArmorIQConfig): ArmorIQConfig {
  return {
    ...config,
    identity: {
      api_key: resolveEnvReference(config.identity.api_key),
      user_id: resolveEnvReference(config.identity.user_id),
      agent_id: resolveEnvReference(config.identity.agent_id),
    },
    mcp_servers: config.mcp_servers.map((s) => ({
      ...s,
      url: resolveEnvReference(s.url),
      auth:
        s.auth.type === 'bearer'
          ? { type: 'bearer', token: resolveEnvReference(s.auth.token ?? '') }
          : s.auth.type === 'api_key'
            ? { type: 'api_key', api_key: resolveEnvReference(s.auth.api_key ?? '') }
            : s.auth,
    })),
  };
}

export function saveArmorIQConfig(config: ArmorIQConfig, filePath: string = 'armoriq.yaml'): void {
  const data: Record<string, any> = {
    version: config.version,
    identity: { ...config.identity },
    environment: config.environment,
    proxy: { ...config.proxy },
    mcp_servers: config.mcp_servers.map((s) => {
      const out: Record<string, any> = {
        id: s.id,
        url: s.url,
        auth:
          s.auth.type === 'none'
            ? 'none'
            : s.auth.type === 'bearer'
              ? { type: 'bearer', token: s.auth.token }
              : { type: 'api_key', api_key: s.auth.api_key },
      };
      if (s.description) out.description = s.description;
      return out;
    }),
    policy: { allow: config.policy.allow, deny: config.policy.deny },
    intent: { ttl_seconds: config.intent.ttl_seconds, require_csrg: config.intent.require_csrg },
  };
  fs.writeFileSync(filePath, yaml.dump(data, { sortKeys: false }), 'utf-8');
}
