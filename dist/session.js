"use strict";
/**
 * ArmorIQSession — the core primitive for framework integrations.
 *
 * Two modes:
 *
 * 1. Observe mode (default, new) — MCP stays on the agent side:
 *      await session.startPlan(toolCalls)                // capture plan + mint token
 *      const decision = await session.enforce(toolName, toolArgs)  // check policy
 *      // ... framework calls MCP directly ...
 *      await session.report(toolName, toolArgs, result)  // audit
 *
 * 2. Proxy mode (legacy) — routes through the Armoriq proxy:
 *      await session.startPlan(toolCalls)
 *      return session.dispatch(toolName, toolArgs)       // proxy handles everything
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArmorIQSession = void 0;
const axios_1 = __importDefault(require("axios"));
const models_1 = require("./models");
const plan_builder_1 = require("./plan-builder");
class ArmorIQSession {
    client;
    toolNameParser;
    defaultMcpName;
    validitySeconds;
    llm;
    mode;
    stepIndex = 0;
    currentPlanHash = null;
    currentTokenValue = null;
    mcpByAction = new Map();
    // Plan-binding: every tool the agent is allowed to invoke this turn.
    // Keys are BOTH the framework's tool name (e.g. "GitHub__search_repositories")
    // and the parsed action name (e.g. "search_repositories") so either matches.
    declaredTools = new Set();
    // Cached IAP public key per kid (one HTTP call per process per key).
    static publicKeyCache = new Map();
    constructor(client, opts = {}) {
        this.client = client;
        this.defaultMcpName = opts.defaultMcpName;
        this.toolNameParser =
            opts.toolNameParser ?? (0, plan_builder_1.defaultToolNameParser)(this.defaultMcpName);
        this.validitySeconds = opts.validitySeconds ?? 3600;
        this.llm = opts.llm ?? 'agent';
        this.mode = opts.mode ?? 'local';
    }
    /**
     * Capture a plan from the LLM's tool calls and mint an intent token.
     * Idempotent: if called again with the same tool-calls list (by SHA),
     * skips the mint and returns the cached token.
     */
    async startPlan(toolCalls, opts = {}) {
        if (toolCalls.length === 0) {
            throw new Error('startPlan called with no tool calls.');
        }
        const hash = (0, plan_builder_1.hashToolCalls)(toolCalls);
        if (this.currentTokenValue && this.currentPlanHash === hash) {
            return this.currentTokenValue;
        }
        const plan = (0, plan_builder_1.buildPlanFromToolCalls)(toolCalls, {
            goal: opts.goal,
            toolNameParser: this.toolNameParser,
            defaultMcpName: this.defaultMcpName,
        });
        this.mcpByAction.clear();
        this.declaredTools.clear();
        for (const step of plan.steps) {
            this.mcpByAction.set(step.action, step.mcp);
            // Plan-binding: record both the action name and the namespaced form
            this.declaredTools.add(step.action);
            this.declaredTools.add(`${step.mcp}__${step.action}`);
        }
        // Also record the original framework-supplied tool names verbatim
        for (const tc of toolCalls) {
            this.declaredTools.add(tc.name);
        }
        const planCapture = this.client.capturePlan(this.llm, opts.goal ?? this.llm, plan);
        const token = await this.client.getIntentToken(planCapture, undefined, this.validitySeconds);
        this.currentPlanHash = hash;
        this.currentTokenValue = token;
        this.stepIndex = 0;
        return token;
    }
    /**
     * Local-mode enforcement.
     * Verifies the intent token's lifetime, plan-binding, and the
     * policy snapshot — all in-process. NO network call to the proxy.
     *
     * Returns { allowed, action, reason }. Plugin uses this to short-
     * circuit the framework's tool dispatch on a deny.
     */
    async enforceLocal(toolName, toolArgs) {
        if (!this.currentTokenValue) {
            return {
                allowed: false,
                action: 'block',
                reason: 'No intent token — call startPlan() first',
            };
        }
        // 1. Token expiry
        if (models_1.IntentToken.isExpired(this.currentTokenValue)) {
            return { allowed: false, action: 'block', reason: 'token-expired' };
        }
        // 2. Plan-binding — tool must have been declared at startPlan() time
        const { mcp, action } = this.toolNameParser(toolName);
        const inPlan = this.declaredTools.has(toolName) ||
            this.declaredTools.has(action) ||
            this.declaredTools.has(`${mcp}__${action}`);
        if (!inPlan) {
            return {
                allowed: false,
                action: 'block',
                reason: `tool-not-in-plan: '${toolName}' was not declared in the captured plan`,
            };
        }
        const pv = this.currentTokenValue.policyValidation;
        const snapshot = this.currentTokenValue.policySnapshot;
        // Find the policy that ACTUALLY governs this tool by walking the
        // snapshot — `matched_policies` is the union for the whole plan
        // (may include unrelated MCPs' policies that ran in the same eval).
        // The policy whose allowedTools include this action OR which
        // explicitly mentions this tool in its rules is "ours".
        const ruleOf = (entry) => entry?.memberRule ?? entry?.clientRule ?? entry?.rules ?? entry;
        const governingEntry = Array.isArray(snapshot)
            ? snapshot.find((entry) => {
                const r = ruleOf(entry);
                if (!r)
                    return false;
                const allowed = Array.isArray(r.allowedTools) ? r.allowedTools : [];
                // A policy "governs" this tool if either:
                //   - the action is in its allowedTools (positive match)
                //   - the action would have been in scope by tool prefix match
                //     (some policies use namespaced names, e.g. "GitHub__search_*")
                if (allowed.includes(action) || allowed.includes(toolName))
                    return true;
                if (allowed.some((t) => t === '*' || t.endsWith('/*') || t.endsWith('*')))
                    return true;
                // Fall back to MCP/target name match if we can find one
                const target = (entry?.targetName || entry?.policyName || '').toLowerCase();
                return target.includes(mcp.toLowerCase());
            })
            : undefined;
        const governingRule = ruleOf(governingEntry);
        const governingPolicyName = governingEntry?.policyName;
        // For "tool not in allowedTools" we use the POLICY-LEVEL default
        // (defaultEnforcementAction, defaults to 'block'). The per-rule
        // enforcementAction is reserved for CONDITIONAL violations like
        // amount thresholds — a tool that isn't allowed at all can't be
        // approved through delegation, only blocked.
        const notAllowedAction = governingEntry?.defaultEnforcementAction ||
            pv?.default_enforcement_action ||
            'block';
        // 3. denied_tools — explicit deny list from backend evaluation.
        //    Only treat as a deny IF we found a governing policy for this tool.
        const deniedTools = pv?.denied_tools;
        if (Array.isArray(deniedTools)) {
            const denied = deniedTools.includes(toolName) || deniedTools.includes(action);
            if (denied) {
                const reasonFromBackend = pv?.denied_reasons?.find((r) => r.startsWith(`${action}:`) || r.startsWith(`${toolName}:`));
                const reason = reasonFromBackend ||
                    (governingPolicyName
                        ? `Tool '${action}' is denied by policy '${governingPolicyName}'`
                        : `Tool '${action}' is denied by policy`);
                return {
                    allowed: false,
                    action: notAllowedAction === 'hold' ? 'hold' : 'block',
                    reason,
                    matchedPolicy: governingPolicyName,
                };
            }
        }
        // 4. Snapshot-based check using the governing policy.
        if (governingRule) {
            const allowed = Array.isArray(governingRule.allowedTools)
                ? governingRule.allowedTools
                : [];
            if (allowed.length > 0) {
                const wildcard = allowed.includes('*');
                const ok = wildcard ||
                    allowed.includes(action) ||
                    allowed.includes(toolName);
                if (!ok) {
                    return {
                        allowed: false,
                        action: notAllowedAction === 'hold' ? 'hold' : 'block',
                        reason: `Tool '${action}' is not in the allowed tools for policy '${governingPolicyName}'`,
                        matchedPolicy: governingPolicyName,
                    };
                }
            }
        }
        else if (Array.isArray(snapshot) && snapshot.length > 0) {
            // We have policies but none govern this tool — for an MCP that has
            // an explicit policy attached, this means "no rule allows it".
            // Don't false-positive on unrelated MCP policies though: only
            // block if `allowed_tools` from the backend is empty for this tool.
            const allowedTools = pv?.allowed_tools;
            if (Array.isArray(allowedTools) && allowedTools.length === 0) {
                return {
                    allowed: false,
                    action: 'block',
                    reason: `Tool '${action}' is not allowed by any policy in scope`,
                };
            }
        }
        // 5. Threshold checks on the governing rule (e.g. amount limits).
        //    Uses tool metadata declared on the platform (amountFields +
        //    amountUnit, set in armorpay's tool-metadata UI) — NO MCP-
        //    specific knowledge in the SDK itself.
        if (governingRule) {
            const decision = await this.evaluateAmountThreshold(governingRule, toolArgs, action, mcp);
            if (decision) {
                return { ...decision, matchedPolicy: governingPolicyName };
            }
        }
        return {
            allowed: true,
            action: 'allow',
            reason: 'Allowed by local policy evaluation',
            matchedPolicy: governingPolicyName,
        };
    }
    /**
     * Check policy for a tool call BEFORE the agent executes it.
     * Calls POST /iap/enforce on the backend.
     * Returns { allowed, action, reason }. The framework plugin uses this
     * to block or let through — the MCP call itself happens on the agent side.
     */
    async enforce(toolName, toolArgs) {
        if (!this.currentTokenValue) {
            throw new Error(`enforce("${toolName}") called before startPlan().`);
        }
        const { mcp, action } = this.toolNameParser(toolName);
        const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
        // Plan-binding check (cheaper than a network call)
        const inPlan = this.declaredTools.has(toolName) ||
            this.declaredTools.has(action) ||
            this.declaredTools.has(`${resolvedMcp}__${action}`);
        if (!inPlan) {
            return {
                allowed: false,
                action: 'block',
                reason: `tool-not-in-plan: '${toolName}' was not declared in the captured plan`,
            };
        }
        try {
            const backendEndpoint = this.client.backendEndpoint || this.client.defaultProxyEndpoint;
            const apiKey = this.client.apiKey;
            const userEmail = this.client.userEmailOverride || this.client.userId;
            const response = await axios_1.default.post(`${backendEndpoint}/iap/sdk/enforce`, {
                tool: action,
                arguments: toolArgs,
                intent_token: this.currentTokenValue.rawToken,
                policy_snapshot: this.currentTokenValue.policySnapshot,
                user_email: userEmail,
            }, {
                headers: {
                    'X-API-Key': apiKey,
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            });
            const data = response.data;
            const rawPolicy = data.matchedPolicy || data.matched_policy;
            const policyName = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy.name : rawPolicy;
            return {
                allowed: data.allowed !== false,
                action: data.enforcementAction || data.action || (data.allowed === false ? 'block' : 'allow'),
                reason: data.reason,
                delegationId: data.delegation_id,
                matchedPolicy: policyName,
            };
        }
        catch (err) {
            if (err.response?.status === 403) {
                const data = err.response.data || {};
                const rawPolicy = data.matchedPolicy || data.matched_policy;
                const policyName = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy.name : rawPolicy;
                return {
                    allowed: false,
                    action: data.enforcementAction || data.action || 'block',
                    reason: data.reason || data.message || err.message,
                    matchedPolicy: policyName,
                };
            }
            // On network error or 5xx, fail open with a warning
            console.warn(`[ArmorIQ] enforce() failed: ${err.message}. Allowing tool call.`);
            return { allowed: true, action: 'allow', reason: 'enforce-unavailable' };
        }
    }
    /**
     * Report a tool execution to the audit log AFTER the agent calls the MCP.
     * Calls POST /iap/audit on the backend.
     */
    async report(toolName, toolArgs, result, opts = {}) {
        const { mcp, action } = this.toolNameParser(toolName);
        const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
        try {
            const backendEndpoint = this.client.backendEndpoint;
            const apiKey = this.client.apiKey;
            const token = this.currentTokenValue;
            await axios_1.default.post(`${backendEndpoint}/iap/audit`, {
                token: token?.jwtToken || token?.tokenId || 'unknown',
                plan_id: token?.planId || token?.tokenId || 'unknown',
                step_index: this.stepIndex,
                action,
                tool: action,
                mcp: resolvedMcp,
                input: toolArgs,
                output: typeof result === 'string' ? { text: result } : (result ?? {}),
                status: opts.status || 'success',
                error_message: opts.errorMessage,
                duration_ms: opts.durationMs,
                is_delegated: opts.isDelegated,
                delegated_by: opts.delegatedBy,
                delegated_to: opts.delegatedTo,
                executed_at: new Date().toISOString(),
            }, {
                headers: {
                    'X-API-Key': apiKey,
                    'Content-Type': 'application/json',
                },
                timeout: 5000,
            });
        }
        catch (err) {
            console.warn(`[ArmorIQ] report() failed: ${err.message}`);
        }
        this.stepIndex++;
    }
    /**
     * [Proxy mode] Route a tool call through the Armoriq proxy.
     * Returns the raw result so the framework can short-circuit
     * its native dispatch. Use this when the proxy handles the
     * upstream MCP connection (e.g. Claude Desktop, Cursor).
     */
    async dispatch(toolName, toolArgs) {
        if (!this.currentTokenValue) {
            throw new Error(`dispatch("${toolName}") called before startPlan().`);
        }
        const { mcp, action } = this.toolNameParser(toolName);
        const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
        const result = await this.client.invoke(resolvedMcp, action, this.currentTokenValue, toolArgs);
        this.stepIndex++;
        return result.result;
    }
    /**
     * Mode-aware enforcement entry point. Plugins should call this and
     * not branch themselves — `mode` on the session decides the path.
     *
     * Behavior by mode:
     *   - 'local'  → allow / block ONLY. In-process, no network calls.
     *                A 'hold' threshold violation is reported as 'block'
     *                with an explanatory reason. Use proxy mode if you
     *                need delegation/approval workflows.
     *   - 'proxy'  → allow / block / hold. The proxy resolves the hold
     *                via the delegation pipeline (request → approve → re-run).
     */
    async check(toolName, toolArgs, opts = {}) {
        if (this.mode === 'local') {
            const decision = await this.enforceLocal(toolName, toolArgs);
            // Local mode is allow/block only — downgrade any 'hold' to 'block'
            // so the agent UX is clear: action requires a more permissive mode.
            if (decision.action === 'hold') {
                return {
                    ...decision,
                    action: 'block',
                    reason: (decision.reason ?? 'requires approval') +
                        ' — switch ARMORIQ_MODE=proxy to enable approval workflows for this action.',
                };
            }
            return decision;
        }
        // Proxy mode: full pipeline including hold + delegation.
        const decision = await this.enforce(toolName, toolArgs);
        if (decision.action !== 'hold')
            return decision;
        return this.handleHold(toolName, toolArgs, decision, opts);
    }
    /**
     * Handle a 'hold' decision: check for prior approval, otherwise
     * create a delegation request. Returns either:
     *   - allowed: true (prior approval found within window)
     *   - allowed: false, action: 'hold', delegationId (request created or pending)
     */
    async handleHold(toolName, toolArgs, holdDecision, opts = {}) {
        const userEmail = opts.userEmail ||
            this.client.userId ||
            'unknown@armoriq';
        const { mcp, action } = this.toolNameParser(toolName);
        const resolvedMcp = this.mcpByAction.get(action) ?? mcp;
        // 1. Check if there's already an approved delegation for this
        //    (user, tool, amount) within the approval window.
        const amount = this.extractAmount(toolArgs);
        try {
            const approved = await this.client.checkApprovedDelegation(userEmail, action, amount ?? 0);
            if (approved && approved.approved !== false) {
                // Mark used so a single approval = single execution
                try {
                    if (approved.delegationId) {
                        await this.client.markDelegationExecuted(userEmail, approved.delegationId);
                    }
                }
                catch {
                    // best-effort
                }
                return {
                    allowed: true,
                    action: 'allow',
                    reason: `Allowed by approved delegation ${approved.delegationId ?? ''}`.trim(),
                    delegationId: approved.delegationId,
                    matchedPolicy: holdDecision.matchedPolicy,
                };
            }
        }
        catch {
            // backend unreachable — fall through to creating a new request
        }
        // 2. No prior approval → create a delegation request (visible in UI).
        let delegationId;
        try {
            const result = await this.client.createDelegationRequest({
                tool: action,
                action,
                arguments: toolArgs,
                amount,
                requesterEmail: userEmail,
                domain: resolvedMcp,
                planId: this.currentTokenValue?.planId,
                intentReference: this.currentTokenValue?.tokenId,
                merkleRoot: this.currentTokenValue?.rawToken?.merkle_root,
                reason: holdDecision.reason,
            });
            delegationId = result?.delegationId;
        }
        catch (err) {
            // If we can't create the request, still return the original block.
            console.warn(`[ArmorIQ] createDelegationRequest failed: ${err.message}`);
        }
        return {
            allowed: false,
            action: 'hold',
            reason: holdDecision.reason ?? 'Pending approval',
            delegationId,
            matchedPolicy: holdDecision.matchedPolicy,
        };
    }
    /**
     * Best-effort extraction of an amount field from arbitrary tool args.
     * Used as a FALLBACK when the platform hasn't declared per-tool
     * metadata. Fully MCP-agnostic — only checks generic field names.
     */
    extractAmount(args) {
        if (!args || typeof args !== 'object')
            return undefined;
        const candidates = ['amount', 'value', 'total', 'price', 'cost'];
        for (const k of candidates) {
            const v = args[k];
            if (v != null && !isNaN(Number(v)))
                return Number(v);
        }
        return undefined;
    }
    /**
     * Resolve the canonical "amount" for a tool call:
     *   1. Try platform-declared tool metadata (amountFields + amountUnit)
     *      — same source the proxy uses (toolMetadata column on MCPServer,
     *      authored in the armorpay UI). MCP-specific units like 'cents'
     *      are normalized HERE, not in the SDK.
     *   2. Fall back to the generic candidate-field extractor.
     */
    async resolveCanonicalAmount(mcp, toolName, args) {
        try {
            const meta = await this.client.fetchToolMetadata(mcp);
            const toolMeta = meta?.toolMetadata?.[toolName];
            if (toolMeta?.amountFields?.length) {
                for (const field of toolMeta.amountFields) {
                    const raw = args?.[field];
                    if (raw == null || isNaN(Number(raw)))
                        continue;
                    const num = Number(raw);
                    return toolMeta.amountUnit === 'cents' ? num / 100 : num;
                }
            }
        }
        catch {
            // metadata fetch failed — fall through to generic extraction
        }
        return this.extractAmount(args);
    }
    /**
     * Evaluate an amount-threshold rule from the policy snapshot against
     * the tool args. Returns:
     *   - undefined if no threshold or amount-not-applicable
     *   - { allowed: false, action: 'block' } if amount > maxPerTransaction
     *   - { allowed: false, action: 'hold'  } if amount > requireApprovalAbove
     */
    async evaluateAmountThreshold(rule, toolArgs, action, mcp) {
        const fin = rule?.financialRule?.amountThreshold ?? rule?.amountThreshold;
        if (!fin || typeof fin !== 'object')
            return undefined;
        const amount = await this.resolveCanonicalAmount(mcp, action, toolArgs);
        if (amount === undefined)
            return undefined;
        const currency = fin.currency || '';
        const maxPer = fin.maxPerTransaction;
        const reqApproval = fin.requireApprovalAbove;
        if (typeof maxPer === 'number' && amount > maxPer) {
            return {
                allowed: false,
                action: 'block',
                reason: `Amount ${amount} ${currency} exceeds maxPerTransaction (${maxPer})`.trim(),
            };
        }
        if (typeof reqApproval === 'number' && amount > reqApproval) {
            return {
                allowed: false,
                action: 'hold',
                reason: `Amount ${amount} ${currency} requires approval (threshold: ${reqApproval})`.trim(),
            };
        }
        return undefined;
    }
    /** Drop cached plan + token so the next startPlan() always mints fresh. */
    reset() {
        this.currentPlanHash = null;
        this.currentTokenValue = null;
        this.mcpByAction.clear();
        this.declaredTools.clear();
        this.stepIndex = 0;
    }
    /** Inspect the currently held intent token (for debugging / audit). */
    get currentToken() {
        return this.currentTokenValue;
    }
    /** Current session mode ('local' default, 'proxy' opt-in). */
    get currentMode() {
        return this.mode;
    }
}
exports.ArmorIQSession = ArmorIQSession;
//# sourceMappingURL=session.js.map