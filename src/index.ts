/**
 * ArmorIQ SDK - Build Secure AI Agents
 *
 * A TypeScript SDK for building AI agents with cryptographic intent verification.
 * Provides simple APIs for plan capture, token management, and secure MCP
 * tool invocation with built-in security.
 *
 * @author ArmorIQ Team <license@armoriq.io>
 * @version 0.2.12
 */

export { ArmorIQClient } from './client';
export { ArmorIQSession, SessionOptions, EnforceResult, ReportOptions } from './session';
export {
  buildPlanFromToolCalls,
  defaultToolNameParser,
  hashToolCalls,
  ToolNameParser,
  BuildPlanOptions,
} from './plan-builder';
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

export const VERSION = '0.2.12';
export const AUTHOR = 'ArmorIQ Team';
export const EMAIL = 'license@armoriq.io';
