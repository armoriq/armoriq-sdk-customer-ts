"use strict";
/**
 * ArmorIQ — Google ADK integration.
 *
 * Wraps the SDK as an ADK `BasePlugin`. Plugin instance is passed to
 * `Runner` (or `InMemoryRunner`) via `plugins: [...]`. End-user agent
 * code is unchanged from a plain ADK setup except for:
 *   1. one extra import
 *   2. one `new ArmorIQADK({ ... })` line
 *   3. passing it into the runner's `plugins` array
 *   4. pointing MCPToolset at the Armoriq proxy URL instead of stdio
 *
 * Usage:
 *
 *   import { LlmAgent, MCPToolset, InMemoryRunner } from '@google/adk';
 *   import { ArmorIQADK } from '@armoriq/sdk-dev/integrations/google-adk';
 *
 *   const armoriq = new ArmorIQADK({ apiKey: API_KEY, proxyUrl: PROXY_URL });
 *
 *   const agent = new LlmAgent({
 *     model: 'gemini-2.5-flash',
 *     name: 'stripe_agent',
 *     instruction: 'You are a Stripe assistant.',
 *     tools: [new MCPToolset({ ... `${PROXY_URL}/mcp/Stripe` ... })],
 *   });
 *
 *   const runner = new InMemoryRunner({ agent, plugins: [armoriq] });
 *
 * Requires: `npm install @google/adk` alongside `@armoriq/sdk`.
 * `@google/adk` is declared as an optional peer dep so users who don't
 * use ADK don't pay for it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArmorIQADK = void 0;
const client_1 = require("../client");
let _BasePluginCache = null;
function loadBasePlugin() {
    if (_BasePluginCache)
        return _BasePluginCache;
    try {
        // Try multiple resolution strategies. The SDK is a dependency of
        // the consumer, so `require('@google/adk')` from here resolves in
        // the SDK's own node_modules (where the package isn't installed).
        // We use createRequire from the consumer's working directory so the
        // lookup walks the consumer's node_modules tree instead.
        const { createRequire } = require('module');
        const consumerRequire = createRequire(process.cwd() + '/package.json');
        const adk = consumerRequire('@google/adk');
        _BasePluginCache = adk.BasePlugin;
        if (!_BasePluginCache) {
            throw new Error('@google/adk is installed but does not export BasePlugin.');
        }
        return _BasePluginCache;
    }
    catch (err) {
        throw new Error('ArmorIQADK requires @google/adk to be installed. ' +
            'Install it: npm install @google/adk\n' +
            `Underlying error: ${err?.message ?? err}`);
    }
}
/**
 * Returns a class that extends ADK's `BasePlugin` at runtime, so the
 * SDK doesn't have to import @google/adk at module load.
 */
function buildArmorIQADKClass() {
    const BasePlugin = loadBasePlugin();
    return class ArmorIQADKImpl extends BasePlugin {
        armoriqClient;
        // Keyed by invocationId (stable string) rather than object identity,
        // because ADK's afterModelCallback and beforeToolCallback receive
        // different Context object instances for the same invocation.
        sessions = new Map();
        opts;
        constructor(opts) {
            super(opts.pluginName ?? 'armoriq');
            this.opts = opts;
            this.armoriqClient =
                opts.client ??
                    new client_1.ArmorIQClient({
                        apiKey: opts.apiKey,
                        proxyEndpoint: opts.proxyUrl,
                        userId: opts.userId,
                        agentId: opts.agentId,
                        mcpCredentials: opts.mcpCredentials,
                    });
        }
        /**
         * After the model returns: extract function calls, mint an intent
         * token, stash a session keyed off the callbackContext for the
         * matching beforeToolCallback to consume.
         */
        async afterModelCallback(params) {
            const { callbackContext, llmResponse } = params;
            const parts = llmResponse?.content?.parts ?? [];
            const toolCalls = parts
                .filter((p) => p && p.functionCall && p.functionCall.name)
                .map((p) => ({
                name: p.functionCall.name,
                args: p.functionCall.args ?? {},
            }));
            if (toolCalls.length === 0)
                return undefined;
            const session = this.armoriqClient.startSession({
                defaultMcpName: this.opts.defaultMcpName,
                toolNameParser: this.opts.toolNameParser,
                llm: this.opts.llm,
                validitySeconds: this.opts.validitySeconds,
                mode: this.opts.mode ?? 'local',
            });
            // ADK's userContent is a Content object ({role, parts}), not a string.
            const rawContent = callbackContext?.userContent ??
                callbackContext?.invocationContext?.userContent;
            let goal = 'agent task';
            if (typeof rawContent === 'string') {
                goal = rawContent;
            }
            else if (rawContent?.parts) {
                const texts = rawContent.parts
                    .filter((p) => typeof p?.text === 'string')
                    .map((p) => p.text);
                if (texts.length > 0)
                    goal = texts.join(' ');
            }
            await session.startPlan(toolCalls, { goal });
            const invocationId = callbackContext?.invocationContext?.invocationId ??
                callbackContext?.invocationId ??
                'default';
            this.sessions.set(invocationId, session);
            return undefined; // do not modify the LLM response
        }
        /**
         * Before each tool call: enforce policy. If blocked, return an
         * error object (short-circuits the tool). If allowed, return
         * undefined so ADK calls the MCP directly — the agent's own
         * MCPToolset handles the connection with its own credentials.
         */
        async beforeToolCallback(params) {
            const { tool, toolArgs, toolContext } = params;
            const invocationId = toolContext?.invocationContext?.invocationId ??
                toolContext?.invocationId ??
                'default';
            const session = this.sessions.get(invocationId);
            if (!session)
                return undefined;
            const toolName = tool?.name ?? String(tool);
            // Pull user email if present (set by ADK runner for the request).
            const userEmail = toolContext?.userEmail ??
                toolContext?.invocationContext?.userEmail ??
                toolContext?.invocationContext?.userId;
            // session.check() picks local vs proxy based on session.mode and
            // handles the delegation flow on a 'hold' decision.
            const decision = await session.check(toolName, toolArgs ?? {}, { userEmail });
            if (!decision.allowed) {
                const policy = decision.matchedPolicy ? ` (policy: ${decision.matchedPolicy})` : '';
                // Hold: poll for approval (3s intervals, up to 60s)
                if (decision.action === 'hold') {
                    console.log(`[armoriq] HELD ${toolName} — waiting for approval...`);
                    let approved = false;
                    let finalDecision = decision;
                    for (let attempt = 0; attempt < 20; attempt++) {
                        await new Promise(r => setTimeout(r, 3000));
                        const retry = await session.check(toolName, toolArgs ?? {}, { userEmail });
                        finalDecision = retry;
                        if (retry.allowed) {
                            console.log(`[armoriq] APPROVED ${toolName} after ${(attempt + 1) * 3}s`);
                            approved = true;
                            break;
                        }
                        if (retry.action !== 'hold') break;
                    }
                    if (approved) {
                        toolContext.__armoriq_start = Date.now();
                        return undefined;
                    }
                    const fp = finalDecision.matchedPolicy ? ` (policy: ${finalDecision.matchedPolicy})` : '';
                    toolContext.__armoriq_blocked = finalDecision;
                    toolContext.__armoriq_blocked_action = finalDecision.action;
                    return {
                        error: finalDecision.action === 'hold'
                            ? `Approval timed out${fp}. Reason: ${finalDecision.reason ?? 'policy-hold'}.`
                            : `This action is not permitted${fp}. Reason: ${finalDecision.reason ?? 'policy-blocked'}.`,
                        armoriq_enforcement: {
                            blocked: true, action: finalDecision.action,
                            reason: finalDecision.reason, matchedPolicy: finalDecision.matchedPolicy,
                            tool: toolName, delegationId: finalDecision.delegationId,
                        },
                    };
                }
                // Hard block
                toolContext.__armoriq_blocked = decision;
                toolContext.__armoriq_blocked_action = decision.action;
                try {
                    await session.report(toolName, toolArgs ?? {}, {
                        blocked: true, reason: decision.reason, action: decision.action,
                    }, { status: 'failed', errorMessage: decision.reason || `Blocked by policy (${decision.action})` });
                }
                catch { }
                return {
                    error: `This action is not permitted by your organization's policy${policy}. Reason: ${decision.reason ?? 'policy-blocked'}.`,
                    armoriq_enforcement: {
                        blocked: true, action: decision.action, reason: decision.reason,
                        matchedPolicy: decision.matchedPolicy, tool: toolName, delegationId: decision.delegationId,
                    },
                };
            }
            // Store start time for duration tracking in afterToolCallback
            toolContext.__armoriq_start = Date.now();
            return undefined; // let ADK call the MCP directly
        }
        /**
         * After each tool call: report execution to audit log.
         * This fires AFTER the MCP returns its result — the agent called
         * the MCP directly, and now we record what happened.
         */
        async afterToolCallback(params) {
            const { tool, toolArgs, toolContext, result } = params;
            const invocationId = toolContext?.invocationContext?.invocationId ??
                toolContext?.invocationId ??
                'default';
            const session = this.sessions.get(invocationId);
            if (!session)
                return undefined;
            // If beforeToolCallback already blocked this call, the audit was
            // written there. Don't double-audit.
            if (toolContext.__armoriq_blocked) {
                return undefined;
            }
            const toolName = tool?.name ?? String(tool);
            const startTime = toolContext.__armoriq_start;
            const durationMs = startTime ? Date.now() - startTime : undefined;
            const hasError = result?.error || result?.isError;
            await session.report(toolName, toolArgs ?? {}, result, {
                status: hasError ? 'failed' : 'success',
                errorMessage: hasError ? String(result.error || result.isError) : undefined,
                durationMs,
            });
            return undefined;
        }
        get armoriqSdk() {
            return this.armoriqClient;
        }
    };
}
let _CachedClass = null;
/**
 * Public class. Constructed lazily so importing this module doesn't
 * trigger the @google/adk lookup until the user actually instantiates.
 *
 * Use:
 *   const armoriq = new ArmorIQADK({ apiKey, proxyUrl });
 *   const runner = new InMemoryRunner({ agent, plugins: [armoriq] });
 */
exports.ArmorIQADK = new Proxy(function () { }, {
    construct(_target, args) {
        if (!_CachedClass)
            _CachedClass = buildArmorIQADKClass();
        return new _CachedClass(...args);
    },
});
//# sourceMappingURL=google-adk.js.map