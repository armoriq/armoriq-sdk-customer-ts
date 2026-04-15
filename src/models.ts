/**
 * Data models for ArmorIQ SDK.
 */

/**
 * Represents a signed intent token from IAP.
 */
export interface IntentToken {
  /** Unique identifier for this token (intent_reference) */
  tokenId: string;
  /** CSRG hash of the canonical plan */
  planHash: string;
  /** Plan ID from IAP */
  planId?: string;
  /** Ed25519 signature from IAP */
  signature: string;
  /** Token issuance timestamp (Unix timestamp) */
  issuedAt: number;
  /** Token expiration timestamp (Unix timestamp) */
  expiresAt: number;
  /** Policy manifest applied to this token */
  policy: Record<string, any>;
  /** Composite identity hash (user+agent+context) */
  compositeIdentity: string;
  /** Client information (clientId, clientName, orgId) */
  clientInfo?: Record<string, any>;
  /** Policy validation result with allowed_tools */
  policyValidation?: Record<string, any>;
  /** Array of Merkle proofs for each step */
  stepProofs: Array<Record<string, any>>;
  /** Total number of steps in plan */
  totalSteps: number;
  /** Full raw token payload */
  rawToken: Record<string, any>;
  /** JWT token for verify-step endpoint */
  jwtToken?: string;
  /** OPA-formatted policy snapshot for proxy → OPA direct enforcement */
  policySnapshot?: Array<Record<string, any>>;
}

/**
 * Helper functions for IntentToken
 */
export namespace IntentToken {
  /**
   * Check if the token has expired.
   */
  export function isExpired(token: IntentToken): boolean {
    return Date.now() / 1000 > token.expiresAt;
  }

  /**
   * Get seconds until token expiry (negative if expired).
   */
  export function timeUntilExpiry(token: IntentToken): number {
    return token.expiresAt - Date.now() / 1000;
  }
}

/**
 * Represents a captured plan ready for token issuance.
 * 
 * The plan structure contains only the steps the agent intends to execute.
 * Hash and Merkle tree generation happens later in getIntentToken() 
 * on the CSRG-IAP service side.
 */
export interface PlanCapture {
  /** Plan structure with steps */
  plan: Record<string, any>;
  /** LLM identifier used to generate the plan */
  llm?: string;
  /** Original prompt used */
  prompt?: string;
  /** Additional metadata */
  metadata: Record<string, any>;
}

/**
 * Represents an MCP action invocation request.
 */
export interface MCPInvocation {
  /** MCP identifier */
  mcp: string;
  /** Action name to invoke (tool name) */
  action: string;
  /** Action parameters */
  params: Record<string, any>;
  /** Intent token for verification */
  intentToken: IntentToken;
  /** Optional Merkle proof for this action */
  merkleProof?: Array<Record<string, any>>;
  /** IAM context to pass to MCP tool (email, user_id, role, limits) */
  iamContext?: Record<string, any>;
}

/**
 * Result from an MCP action invocation.
 */
export interface MCPInvocationResult {
  /** MCP identifier */
  mcp: string;
  /** Action that was invoked */
  action: string;
  /** Action result data */
  result: any;
  /** Execution status */
  status: string;
  /** Time taken to execute (seconds) */
  executionTime?: number;
  /** Whether token verification succeeded */
  verified: boolean;
  /** Extra metadata */
  metadata: Record<string, any>;
}

/**
 * Request for delegating a subtask to another agent.
 */
export interface DelegationRequest {
  /** Target agent identifier */
  targetAgent: string;
  /** Subtask plan to delegate */
  subtask: Record<string, any>;
  /** Current intent token */
  intentToken: IntentToken;
  /** Optional trust policy for delegation */
  trustPolicy?: Record<string, any>;
  /** Public key of delegate agent */
  delegatePublicKey: string;
  /** Token validity in seconds */
  validitySeconds: number;
}

/**
 * Result from a delegation request.
 */
export interface DelegationResult {
  /** Unique delegation identifier */
  delegationId: string;
  /** New intent token for the delegated subtask */
  delegatedToken: IntentToken;
  /** Public key of the delegate agent */
  delegatePublicKey: string;
  /** Optional target agent identifier */
  targetAgent?: string;
  /** Expiration timestamp */
  expiresAt: number;
  /** Trust update applied */
  trustDelta: Record<string, any>;
  /** Delegation status */
  status: string;
  /** Extra metadata */
  metadata: Record<string, any>;
}

/**
 * Semantic metadata for a single tool on an MCP server.
 */
export interface ToolSemanticEntry {
  isFinancial?: boolean;
  transactionType?: string;
  amountFields?: string[];
  amountUnit?: string;
  currency?: string;
  recipientField?: string;
  category?: string;
}

/**
 * Semantic metadata for an MCP server (tool annotations + role mapping).
 */
export interface MCPSemanticMetadata {
  mcpId: string;
  name: string;
  toolMetadata: Record<string, ToolSemanticEntry>;
  roleMapping: Record<string, string>;
}

/**
 * Policy context enriched from semantic metadata.
 */
export interface PolicyContext {
  is_financial: boolean;
  transaction_type?: string;
  amount?: number;
  recipient_id?: string;
}

/**
 * Options for the enhanced invoke() method.
 */
export interface InvokeOptions {
  /** Automatically poll for delegation approval on hold */
  waitForApproval?: boolean;
  /** Max time to wait for delegation approval (ms, default 30min) */
  delegationTimeoutMs?: number;
  /** Callback when a hold is detected */
  onHold?: (info: HoldInfo) => void;
  /** User email for delegation context */
  userEmail?: string;
  /** Requester's role for delegation (auto-resolved if not provided) */
  requesterRole?: string;
  /** Requester's approval limit for delegation (auto-resolved if not provided) */
  requesterLimit?: number;
}

/**
 * Information about a hold enforcement action.
 */
export interface HoldInfo {
  delegationId?: string;
  reason: string;
  amount?: number;
  approvalThreshold?: number;
  tool: string;
  mcp: string;
}

/**
 * Parameters for creating a delegation request.
 */
export interface DelegationRequestParams {
  tool: string;
  action: string;
  arguments?: Record<string, unknown>;
  amount?: number;
  requesterEmail: string;
  requesterRole?: string;
  requesterLimit?: number;
  domain?: string;
  targetUrl?: string;
  planId?: string;
  intentReference?: string;
  merkleRoot?: string;
  reason?: string;
}

/**
 * Result from creating a delegation request.
 */
export interface DelegationRequestResult {
  delegationId: string;
  status: string;
  expiresAt: string;
}

/**
 * Result from checking an approved delegation.
 */
export interface ApprovedDelegation {
  delegationId: string;
  approverEmail: string;
  approverRole: string;
  delegationToken?: string;
}

/**
 * A single tool call as surfaced by an LLM framework (ADK, LangChain,
 * OpenAI Agents, Vercel AI SDK, etc.). Used by ArmorIQSession to capture
 * a plan without making the caller hand-build the SDK plan shape.
 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Credential for an upstream MCP. Forwarded per-call to the proxy via
 * the X-Armoriq-MCP-Auth header. The proxy injects the appropriate
 * upstream auth header and drops this one before forwarding. Armoriq
 * does NOT store these.
 */
export type McpCredential =
  | { authType: 'bearer'; token: string }
  | { authType: 'api_key'; apiKey: string; headerName?: string }
  | { authType: 'basic'; username: string; password: string }
  | { authType: 'none' };

/**
 * Map of MCP identifier (the name registered on the platform) to its
 * runtime credential.
 */
export type McpCredentialMap = Record<string, McpCredential>;

/**
 * SDK configuration.
 */
export interface SDKConfig {
  /** IAP service endpoint URL */
  iapEndpoint: string;
  /** Default proxy endpoint URL */
  proxyEndpoint: string;
  /** Backend endpoint URL */
  backendEndpoint: string;
  /** Mapping of MCP identifiers to proxy URLs */
  proxyEndpoints: Record<string, string>;
  /** User identifier */
  userId: string;
  /** Agent identifier */
  agentId: string;
  /** Context identifier */
  contextId?: string;
  /** Request timeout in seconds */
  timeout: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Verify SSL certificates */
  verifySsl: boolean;
  /** API key for authentication */
  apiKey?: string;
  /** Use production endpoints */
  useProduction: boolean;
  /** Per-MCP runtime credentials (agent-managed cred path) */
  mcpCredentials?: McpCredentialMap;
}
