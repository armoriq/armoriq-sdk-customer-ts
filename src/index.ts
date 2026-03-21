/**
 * ArmorIQ SDK - Build Secure AI Agents
 * 
 * A TypeScript SDK for building AI agents with cryptographic intent verification.
 * Provides simple APIs for plan capture, token management, and secure MCP
 * tool invocation with built-in security.
 * 
 * @author ArmorIQ Team <license@armoriq.io>
 * @version 0.2.6
 */

export { ArmorIQClient } from './client';
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
} from './models';

export const VERSION = '0.2.6';
export const AUTHOR = 'ArmorIQ Team';
export const EMAIL = 'license@armoriq.io';
