/**
 * ArmorIQ SDK Client - Main entry point for SDK usage.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as crypto from 'crypto';
import {
  IntentToken,
  PlanCapture,
  MCPInvocationResult,
  DelegationResult,
  SDKConfig,
} from './models';
import {
  InvalidTokenException,
  IntentMismatchException,
  MCPInvocationException,
  DelegationException,
  TokenExpiredException,
  ConfigurationException,
} from './exceptions';

/**
 * Main client for ArmorIQ SDK.
 * 
 * Provides high-level APIs for:
 * - Plan capture and canonicalization
 * - Intent token management
 * - MCP action invocation
 * - Agent delegation
 */
export class ArmorIQClient {
  // Production endpoints (default) - Customer-facing services
  private static readonly DEFAULT_IAP_ENDPOINT = 'https://customer-iap.armoriq.ai';
  private static readonly DEFAULT_PROXY_ENDPOINT = 'https://customer-proxy.armoriq.ai';
  private static readonly DEFAULT_BACKEND_ENDPOINT = 'https://customer-api.armoriq.ai';

  // Local development endpoints
  private static readonly LOCAL_IAP_ENDPOINT = 'http://127.0.0.1:8000';
  private static readonly LOCAL_PROXY_ENDPOINT = 'http://127.0.0.1:3001';
  private static readonly LOCAL_BACKEND_ENDPOINT = 'http://127.0.0.1:3000';

  private iapEndpoint: string;
  private defaultProxyEndpoint: string;
  private backendEndpoint: string;
  private proxyEndpoints: Record<string, string>;
  private userId: string;
  private agentId: string;
  private contextId: string;
  private apiKey: string;
  private timeout: number;
  private maxRetries: number;
  private verifySsl: boolean;
  private httpClient: AxiosInstance;
  private tokenCache: Map<string, IntentToken>;

  constructor(options: Partial<SDKConfig> & { apiKey?: string; useProduction?: boolean } = {}) {
    // Determine if using production based on environment
    const envMode = process.env.ARMORIQ_ENV?.toLowerCase() || 'production';
    const useProd = (options.useProduction ?? true) && envMode === 'production';
    //const envMode = process.env.ARMORIQ_ENV?.toLowerCase() || 'development';
    //const useProd = (options.useProduction ?? false) || envMode === 'production';

    // Load IAP endpoint
    this.iapEndpoint =
      options.iapEndpoint ||
      process.env.IAP_ENDPOINT ||
      (useProd ? ArmorIQClient.DEFAULT_IAP_ENDPOINT : ArmorIQClient.LOCAL_IAP_ENDPOINT);

    // Load proxy endpoint
    this.defaultProxyEndpoint =
      options.proxyEndpoint ||
      process.env.PROXY_ENDPOINT ||
      (useProd ? ArmorIQClient.DEFAULT_PROXY_ENDPOINT : ArmorIQClient.LOCAL_PROXY_ENDPOINT);

    // Load backend endpoint
    this.backendEndpoint =
      options.backendEndpoint ||
      process.env.BACKEND_ENDPOINT ||
      (useProd ? ArmorIQClient.DEFAULT_BACKEND_ENDPOINT : ArmorIQClient.LOCAL_BACKEND_ENDPOINT);

    // Load user/agent identifiers
    this.userId = options.userId || process.env.USER_ID || '';
    this.agentId = options.agentId || process.env.AGENT_ID || '';
    this.contextId = options.contextId || process.env.CONTEXT_ID || 'default';
    this.apiKey = options.apiKey || process.env.ARMORIQ_API_KEY || '';

    // Validate required config
    if (!this.apiKey) {
      throw new ConfigurationException(
        'API key is required for Customer SDK. ' +
          'Set ARMORIQ_API_KEY environment variable or pass apiKey parameter. ' +
          'Get your API key from https://platform.armoriq.ai/dashboard/api-keys'
      );
    }

    // Validate API key format
    if (!this.apiKey.startsWith('ak_live_') && !this.apiKey.startsWith('ak_test_')) {
      throw new ConfigurationException(
        "Invalid API key format. API keys must start with 'ak_live_' or 'ak_test_'. " +
          'Get your API key from https://platform.armoriq.ai/dashboard/api-keys'
      );
    }

    if (!this.userId) {
      throw new ConfigurationException('userId is required (set USER_ID env var)');
    }
    if (!this.agentId) {
      throw new ConfigurationException('agentId is required (set AGENT_ID env var)');
    }

    this.proxyEndpoints = options.proxyEndpoints || {};
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.verifySsl = options.verifySsl ?? true;

    // Initialize HTTP client
    const headers: Record<string, string> = {
      'User-Agent': `ArmorIQ-SDK-TS/0.2.6 (agent=${this.agentId})`,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    this.httpClient = axios.create({
      timeout: this.timeout,
      headers,
      validateStatus: () => true, // Handle all status codes manually
    });

    this.tokenCache = new Map();

    console.log(
      `ArmorIQ SDK initialized: mode=${useProd ? 'production' : 'development'}, ` +
        `user=${this.userId}, agent=${this.agentId}, ` +
        `iap=${this.iapEndpoint}, proxy=${this.defaultProxyEndpoint}, ` +
        `backend=${this.backendEndpoint}, ` +
        `api_key=${'***' + this.apiKey.slice(-8)}`
    );

    // Validate API key on initialization
    this.validateApiKey();
  }

  /**
   * Get the default proxy endpoint URL.
   */
  get proxyEndpoint(): string {
    return this.defaultProxyEndpoint;
  }

  /**
   * Validate API key with the proxy server.
   */
  private async validateApiKey(): Promise<void> {
    try {
      const response = await this.httpClient.get(`${this.proxyEndpoint}/health`, {
        headers: { 'X-API-Key': this.apiKey },
        timeout: 5000,
      });

      if (response.status === 401) {
        throw new ConfigurationException(
          'Invalid API key. Please check your API key at https://platform.armoriq.ai/dashboard/api-keys'
        );
      } else if (response.status >= 400) {
        console.warn(`API key validation returned status ${response.status}, but continuing...`);
      } else {
        console.log('✅ API key validated successfully');
      }
    } catch (error: any) {
      if (error instanceof ConfigurationException) {
        throw error;
      }
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.warn(`Could not connect to proxy at ${this.proxyEndpoint} for API key validation`);
      } else {
        console.warn(`API key validation check failed: ${error.message}, but continuing...`);
      }
    }
  }

  /**
   * Capture an execution plan structure.
   */
  capturePlan(
    llm: string,
    prompt: string,
    plan?: Record<string, any>,
    metadata?: Record<string, any>
  ): PlanCapture {
    console.log(`Capturing plan: llm=${llm}, prompt=${prompt.slice(0, 50)}...`);

    if (!plan) {
      throw new Error(
        'Plan structure is required. ' +
          'You must provide an explicit plan with the MCP and actions you want to execute.\n\n' +
          'Example:\n' +
          '  const plan = client.capturePlan(\n' +
          "    'gpt-4',\n" +
          "    'Your task description',\n" +
          '    {\n' +
          "      goal: 'Your task description',\n" +
          '      steps: [\n' +
          '        {\n' +
          "          action: 'your_tool_name',\n" +
          "          mcp: 'your-mcp-name',\n" +
          "          params: { param1: 'value1' }\n" +
          '        }\n' +
          '      ]\n' +
          '    }\n' +
          '  );\n\n' +
          'Note: Use the MCP name and tool names from your onboarded MCPs on the ArmorIQ platform.'
      );
    }

    if (!plan.steps) {
      throw new Error("Plan must contain 'steps' key");
    }

    const capture: PlanCapture = {
      plan,
      llm,
      prompt,
      metadata: metadata || {},
    };

    console.log(`Plan captured with ${plan.steps?.length || 0} steps`);
    return capture;
  }

  /**
   * Request a signed intent token from IAP for the given plan.
   */
  async getIntentToken(
    planCapture: PlanCapture,
    policy?: Record<string, any>,
    validitySeconds: number = 60.0
  ): Promise<IntentToken> {
    console.log(
      `Requesting intent token for plan with ${planCapture.plan.steps?.length || 0} steps`
    );

    const payload = {
      user_id: this.userId,
      agent_id: this.agentId,
      context_id: this.contextId,
      plan: planCapture.plan,
      policy,
      expires_in: validitySeconds,
    };

    try {
      const response = await this.httpClient.post(`${this.backendEndpoint}/iap/sdk/token`, payload, {
        headers: { 'X-API-Key': this.apiKey },
        timeout: 30000,
      });

      if (response.status >= 400) {
        throw new InvalidTokenException(
          `Token issuance failed: ${response.data?.message || response.statusText}`
        );
      }

      const data = response.data;
      if (!data.success) {
        throw new InvalidTokenException(`Token issuance failed: ${data.message || 'Unknown error'}`);
      }

      const tokenData = data.token || {};
      const rawToken = {
        plan: planCapture.plan,
        token: tokenData,
        plan_hash: data.plan_hash,
        merkle_root: data.merkle_root,
        intent_reference: data.intent_reference,
        composite_identity: data.composite_identity || '',
        step_proofs: data.step_proofs || [],
      };

      const token: IntentToken = {
        tokenId: data.intent_reference || 'unknown',
        planHash: data.plan_hash || '',
        planId: data.plan_id,
        signature: typeof tokenData === 'object' ? tokenData.signature || '' : '',
        issuedAt: Date.now() / 1000,
        expiresAt: Date.now() / 1000 + validitySeconds,
        policy: policy || {},
        compositeIdentity: data.composite_identity || '',
        clientInfo: data.client_info,
        policyValidation: data.policy_validation,
        stepProofs: data.step_proofs || [],
        totalSteps: planCapture.plan.steps?.length || 0,
        rawToken,
        jwtToken: data.jwt_token,
      };

      console.log(
        `Intent token issued: id=${token.tokenId}, plan_hash=${token.planHash.slice(0, 16)}..., ` +
          `expires=${IntentToken.timeUntilExpiry(token).toFixed(1)}s, stepProofs=${token.stepProofs?.length || 0}`
      );
      return token;
    } catch (error: any) {
      if (error instanceof InvalidTokenException) {
        throw error;
      }
      const message = error.response?.data || error.message;
      throw new InvalidTokenException(`Failed to get intent token: ${message}`);
    }
  }

  /**
   * Invoke an MCP action through the ArmorIQ proxy with token verification.
   */
  async invoke(
    mcp: string,
    action: string,
    intentToken: IntentToken,
    params?: Record<string, any>,
    merkleProof?: Array<Record<string, any>>,
    userEmail?: string
  ): Promise<MCPInvocationResult> {
    console.log(`Invoking MCP action: mcp=${mcp}, action=${action}`);

    // Check token expiry
    if (IntentToken.isExpired(intentToken)) {
      throw new TokenExpiredException(
        `Intent token expired ${Math.abs(IntentToken.timeUntilExpiry(intentToken)).toFixed(1)}s ago`,
        intentToken.tokenId,
        intentToken.expiresAt
      );
    }

    // Get proxy endpoint for this MCP
    let proxyUrl =
      this.proxyEndpoints[mcp] ||
      process.env[`${mcp.toUpperCase()}_PROXY_URL`] ||
      this.defaultProxyEndpoint;

    // Build IAM context
    const iamContext: Record<string, any> = {};
    if (intentToken.policyValidation) {
      iamContext.allowed_tools = intentToken.policyValidation.allowed_tools || [];
    }
    if (userEmail) {
      iamContext.email = userEmail;
      iamContext.user_email = userEmail;
    }
    if (intentToken.rawToken) {
      iamContext.user_id = intentToken.rawToken.user_id || this.userId;
      iamContext.agent_id = intentToken.rawToken.agent_id || this.agentId;
    }

    // Prepare invocation payload
    const invokeParams: Record<string, any> = { ...(params || {}), _iam_context: iamContext };
    if (userEmail) {
      invokeParams.user_email = userEmail;
    }

    const payload: Record<string, any> = {
      mcp,
      action,
      tool: action,
      params: invokeParams,
      arguments: invokeParams,
      intent_token: intentToken.rawToken,
      merkle_proof: merkleProof,
      plan: intentToken.rawToken?.plan,
    };

    // Prepare headers
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Request-ID': `sdk-${Date.now()}`,
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    // Send CSRG token structure
    if (intentToken.rawToken && typeof intentToken.rawToken === 'object') {
      payload.token = intentToken.rawToken.token || {};
      payload.csrg_token = intentToken.rawToken.token || {};
    }

    // Find step index for this action
    const plan = intentToken.rawToken?.plan || {};
    const steps = plan.steps || [];
    let stepIndex: number | null = null;
    for (let idx = 0; idx < steps.length; idx++) {
      if (typeof steps[idx] === 'object' && steps[idx].action === action) {
        stepIndex = idx;
        break;
      }
    }

    if (stepIndex === null) {
      const actions = steps.map((s: any) => (typeof s === 'object' ? s.action : 'unknown'));
      throw new IntentMismatchException(
        `Action '${action}' not found in the original plan. ` +
          `Plan contains actions: ${JSON.stringify(actions)}. ` +
          'You can only invoke actions that were included in the plan when you called capturePlan().'
      );
    }

    // Use Merkle proof from CSRG-IAP
    if (!merkleProof) {
      if (intentToken.stepProofs && intentToken.stepProofs.length > stepIndex) {
        merkleProof = intentToken.stepProofs[stepIndex] as any;
        console.log(`Using Merkle proof from CSRG-IAP for step ${stepIndex}`);
      } else {
        console.warn(
          `No Merkle proof available for step ${stepIndex}. ` +
            `step_proofs length: ${intentToken.stepProofs?.length || 0}`
        );
      }
    }

    // Add CSRG proof to headers
    if (merkleProof) {
      headers['X-CSRG-Proof'] = JSON.stringify(merkleProof);
    }

    const csrgPath = `/steps/[${stepIndex}]/action`;
    headers['X-CSRG-Path'] = csrgPath;

    // Calculate value digest
    const stepObj = steps[stepIndex] || {};
    const leafValue = typeof stepObj === 'object' ? stepObj.action || action : action;
    const valueStr = JSON.stringify(leafValue);
    const valueDigest = crypto.createHash('sha256').update(valueStr, 'utf8').digest('hex');
    headers['X-CSRG-Value-Digest'] = valueDigest;

    // Call proxy
    try {
      const startTime = Date.now();
      const response = await this.httpClient.post(`${proxyUrl}/invoke`, payload, { headers });

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const executionTime = (Date.now() - startTime) / 1000;
      const contentType = response.headers['content-type'] || '';
      let data: any;

      // Handle SSE format
      if (contentType.includes('text/event-stream')) {
        const lines = response.data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              data = JSON.parse(line.slice(6));
              break;
            } catch (e) {
              continue;
            }
          }
        }
        if (!data) {
          throw new MCPInvocationException('No data in SSE response', mcp, action);
        }
      } else {
        data = response.data;
      }

      // Check for JSON-RPC error
      if (data.error) {
        const errorMsg = data.error.message || 'Unknown error';
        const errorCode = data.error.code || -1;
        const errorData = data.error.data || '';
        throw new MCPInvocationException(
          `MCP tool error (${errorCode}): ${errorMsg} - ${errorData}`,
          mcp,
          action
        );
      }

      const resultData = data.result || data;
      const result: MCPInvocationResult = {
        mcp,
        action,
        result: resultData,
        status: 'success',
        executionTime,
        verified: true,
        metadata: {},
      };

      console.log(`MCP invocation succeeded: ${action} in ${executionTime.toFixed(2)}s`);
      return result;
    } catch (error: any) {
      if (error instanceof MCPInvocationException) {
        throw error;
      }

      const statusCode = error.response?.status;
      const errorDetail = error.response?.data || error.message;

      if (statusCode === 401 || statusCode === 403) {
        throw new InvalidTokenException(`Token verification failed: ${errorDetail}`);
      } else if (statusCode === 409) {
        throw new IntentMismatchException(
          `Action not in plan: ${errorDetail}`,
          action,
          intentToken.planHash
        );
      } else {
        throw new MCPInvocationException(
          `MCP invocation failed: ${errorDetail}`,
          mcp,
          action,
          statusCode
        );
      }
    }
  }

  /**
   * Delegate authority to another agent using CSRG token delegation.
   */
  async delegate(
    intentToken: IntentToken,
    delegatePublicKey: string,
    validitySeconds: number = 3600,
    allowedActions?: string[],
    targetAgent?: string,
    subtask?: Record<string, any>
  ): Promise<DelegationResult> {
    console.log(
      `Creating delegation for token_id=${intentToken.tokenId}, ` +
        `delegate_key=${delegatePublicKey.slice(0, 16)}..., validity=${validitySeconds}s`
    );

    let tokenToDelegate = intentToken.rawToken;
    if (typeof tokenToDelegate === 'object' && 'token' in tokenToDelegate) {
      tokenToDelegate = tokenToDelegate.token;
    }

    const payload: Record<string, any> = {
      token: tokenToDelegate,
      delegate_public_key: delegatePublicKey,
      validity_seconds: validitySeconds,
    };

    if (allowedActions) {
      payload.allowed_actions = allowedActions;
    }
    if (targetAgent) {
      payload.target_agent = targetAgent;
    }
    if (subtask) {
      payload.subtask = subtask;
    }

    try {
      const response = await this.httpClient.post(`${this.iapEndpoint}/delegation/create`, payload, {
        timeout: 10000,
      });

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = response.data;
      const delegatedTokenData = data.delegation || data.delegated_token || data.new_token;

      if (!delegatedTokenData) {
        throw new DelegationException(
          `Delegation response missing 'delegation' key. Got keys: ${Object.keys(data).join(', ')}`,
          undefined,
          data.delegation_id
        );
      }

      const delegatedToken: IntentToken = {
        tokenId: delegatedTokenData.token_id || '',
        planHash: delegatedTokenData.plan_hash || intentToken.planHash,
        planId: delegatedTokenData.plan_id,
        signature: delegatedTokenData.signature || '',
        issuedAt: delegatedTokenData.issued_at || Date.now() / 1000,
        expiresAt: delegatedTokenData.expires_at || 0,
        policy: delegatedTokenData.policy || {},
        compositeIdentity: delegatedTokenData.composite_identity || '',
        clientInfo: delegatedTokenData.client_info,
        policyValidation: delegatedTokenData.policy_validation,
        stepProofs: delegatedTokenData.step_proofs || [],
        totalSteps: delegatedTokenData.total_steps || 0,
        rawToken: { token: delegatedTokenData },
      };

      const result: DelegationResult = {
        delegationId: data.delegation_id || delegatedToken.tokenId,
        delegatedToken,
        delegatePublicKey,
        targetAgent,
        expiresAt: delegatedToken.expiresAt,
        trustDelta: data.trust_delta || {},
        status: 'delegated',
        metadata: data.metadata || {},
      };

      console.log(`Delegation successful: delegation_id=${result.delegationId}`);
      return result;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const errorDetail = error.response?.data || error.message;
      throw new DelegationException(
        `Delegation failed: ${errorDetail}`,
        targetAgent,
        undefined,
        statusCode
      );
    }
  }

  /**
   * Verify an intent token with IAP.
   */
  async verifyToken(intentToken: IntentToken): Promise<boolean> {
    try {
      if (IntentToken.isExpired(intentToken)) {
        console.warn(`Token ${intentToken.tokenId} has expired`);
        return false;
      }

      if (!intentToken.signature || !intentToken.planHash) {
        console.warn(`Token ${intentToken.tokenId} missing required fields`);
        return false;
      }

      console.log(
        `Token ${intentToken.tokenId} is valid (expires in ${IntentToken.timeUntilExpiry(intentToken).toFixed(1)}s)`
      );
      return true;
    } catch (error: any) {
      console.error(`Token verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Close HTTP client and cleanup resources.
   */
  close(): void {
    // Axios doesn't require explicit cleanup
    console.log('ArmorIQ SDK client closed');
  }
}
