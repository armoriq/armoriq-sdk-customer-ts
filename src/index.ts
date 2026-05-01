/**
 * ArmorIQ SDK - Build Secure AI Agents
 * 
 * A TypeScript SDK for building AI agents with cryptographic intent verification.
 * Provides simple APIs for plan capture, token management, and secure MCP
 * tool invocation with built-in security.
 * 
 * @author ArmorIQ Team <license@armoriq.io>
 * @version 0.3.0
 */

export { ArmorIQClient, ArmorIQUserScope } from './client';
export {
  ArmorIQSession,
  SessionOptions,
  SessionMode,
  EnforceResult,
  ReportOptions,
} from './session';
export {
  ArmorIQException,
  InvalidTokenException,
  IntentMismatchException,
  MCPInvocationException,
  TokenExpiredException,
  DelegationException,
  ConfigurationException,
  PolicyBlockedException,
  PolicyHoldException,
} from './exceptions';
export {
  IntentToken,
  PlanCapture,
  MCPInvocation,
  MCPInvocationResult,
  DelegationRequest,
  DelegationResult,
  SDKConfig,
  MCPSemanticMetadata,
  ToolSemanticEntry,
  PolicyContext,
  InvokeOptions,
  HoldInfo,
  DelegationRequestParams,
  DelegationRequestResult,
  ApprovedDelegation,
  ToolCall,
  McpCredential,
  McpCredentialMap,
} from './models';

export {
  defaultToolNameParser,
  buildPlanFromToolCalls,
  hashToolCalls,
  ToolNameParser,
  PlanStep,
  BuiltPlan,
} from './plan_builder';

export {
  ArmorIQConfig,
  ArmorIQConfigError,
  IdentityConfig,
  ProxyConfig,
  MCPAuthConfig,
  MCPAuthType,
  MCPServerConfig,
  PolicyConfig,
  IntentConfig,
  Environment,
  loadArmorIQConfig,
  parseArmorIQConfig,
  resolveEnvReference,
  resolveEnvReferences,
  saveArmorIQConfig,
  DEFAULT_PROXY_URL,
} from './config';

export const VERSION = '0.3.0';
export const AUTHOR = 'ArmorIQ Team';
export const EMAIL = 'license@armoriq.io';
