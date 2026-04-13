/**
 * ArmorIQ + Google ADK — Stripe agent example.
 *
 * Mirrors the "After" snippet in ARMORIQ_INTEGRATION.md:
 *  - 8 lines changed vs. a plain ADK + Stripe MCP agent
 *  - Agent never holds the upstream Stripe key directly; Armoriq
 *    forwards it from the per-agent env (or the platform-stored cred
 *    if onboarded that way).
 *
 * Run:
 *   ARMORIQ_API_KEY=ak_live_... \
 *   ARMORIQ_PROXY_URL=http://localhost:3001 \
 *   GOOGLE_API_KEY=... \
 *   ARMORIQ_MCP_STRIPE_AUTH_TYPE=bearer \
 *   ARMORIQ_MCP_STRIPE_TOKEN=sk_test_... \
 *   npx tsx examples/adk-stripe-agent.ts "list customers"
 */

import 'dotenv/config';
// @ts-ignore — @google/adk is an optional peer dep; consumers install it.
import { LlmAgent, MCPToolset, Runner } from '@google/adk';
import { ArmorIQADK } from '../src/integrations/google-adk';

const PROXY_URL = process.env.ARMORIQ_PROXY_URL || 'http://localhost:3001';
const API_KEY = process.env.ARMORIQ_API_KEY!;
const MCP_NAME = process.env.MCP_NAME || 'Stripe';

const armoriq = new ArmorIQADK({ apiKey: API_KEY, proxyUrl: PROXY_URL });

export const rootAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: `${MCP_NAME.toLowerCase()}_agent`,
  description: `An agent that interacts with ${MCP_NAME}.`,
  instruction: `You are a helpful ${MCP_NAME} assistant. Use the available tools.`,
  plugins: [armoriq],
  tools: [
    new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: `${PROXY_URL}/mcp/${MCP_NAME}`,
      transportOptions: {
        requestInit: { headers: { 'X-API-Key': API_KEY } },
      },
    }),
  ],
});

if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ') || 'List my recent customers';
  Runner.runSync(rootAgent, prompt).then((r: unknown) => console.log(r));
}
