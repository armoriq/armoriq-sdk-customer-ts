/**
 * Custom exceptions for ArmorIQ SDK.
 */

/**
 * Base exception for all ArmorIQ SDK errors.
 */
export class ArmorIQException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArmorIQException';
    Object.setPrototypeOf(this, ArmorIQException.prototype);
  }
}

/**
 * Raised when an intent token is invalid.
 * 
 * This can occur due to:
 * - Invalid signature
 * - Token expiration
 * - Token revocation
 * - Malformed token structure
 */
export class InvalidTokenException extends ArmorIQException {
  public tokenId?: string;

  constructor(message: string, tokenId?: string) {
    super(message);
    this.name = 'InvalidTokenException';
    this.tokenId = tokenId;
    Object.setPrototypeOf(this, InvalidTokenException.prototype);
  }
}

/**
 * Raised when an action doesn't match the original intent plan.
 * 
 * This occurs when trying to execute an action that was not
 * included in the canonicalized plan used to generate the token.
 */
export class IntentMismatchException extends ArmorIQException {
  public action?: string;
  public planHash?: string;

  constructor(message: string, action?: string, planHash?: string) {
    super(message);
    this.name = 'IntentMismatchException';
    this.action = action;
    this.planHash = planHash;
    Object.setPrototypeOf(this, IntentMismatchException.prototype);
  }
}

/**
 * Raised when an intent token has expired.
 * 
 * Tokens have a validity period set during issuance.
 * This exception is raised when attempting to use an expired token.
 */
export class TokenExpiredException extends InvalidTokenException {
  public expiredAt?: number;

  constructor(message: string, tokenId?: string, expiredAt?: number) {
    super(message, tokenId);
    this.name = 'TokenExpiredException';
    this.expiredAt = expiredAt;
    Object.setPrototypeOf(this, TokenExpiredException.prototype);
  }
}

/**
 * Raised when an MCP action invocation fails.
 * 
 * This can occur due to:
 * - MCP server unavailable
 * - Action not found
 * - Invalid parameters
 * - Proxy verification failure
 */
export class MCPInvocationException extends ArmorIQException {
  public mcp?: string;
  public action?: string;
  public statusCode?: number;

  constructor(message: string, mcp?: string, action?: string, statusCode?: number) {
    super(message);
    this.name = 'MCPInvocationException';
    this.mcp = mcp;
    this.action = action;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, MCPInvocationException.prototype);
  }
}

/**
 * Raised when agent delegation fails.
 * 
 * This can occur due to:
 * - Target agent unavailable
 * - Trust delegation rejected
 * - Invalid subtask structure
 */
export class DelegationException extends ArmorIQException {
  public targetAgent?: string;
  public delegationId?: string;
  public statusCode?: number;

  constructor(
    message: string,
    targetAgent?: string,
    delegationId?: string,
    statusCode?: number
  ) {
    super(message);
    this.name = 'DelegationException';
    this.targetAgent = targetAgent;
    this.delegationId = delegationId;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, DelegationException.prototype);
  }
}

/**
 * Raised when SDK configuration is invalid.
 * 
 * This can occur due to:
 * - Missing required configuration
 * - Invalid endpoint URLs
 * - Missing credentials
 */
export class ConfigurationException extends ArmorIQException {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationException';
    Object.setPrototypeOf(this, ConfigurationException.prototype);
  }
}
