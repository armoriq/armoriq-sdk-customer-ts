/**
 * ArmorIQ SDK — Framework integrations.
 *
 * Mirrors the shape of armoriq_sdk.integrations in the Python SDK.
 * Each integration is importable on its own subpath so consumers only
 * pay for the peer dep they actually use, e.g.:
 *
 *   import { ArmorIQADK }      from '@armoriq/sdk-dev/integrations/google-adk';
 *   import { ArmorIQCrew }     from '@armoriq/sdk-dev/integrations/crewai';
 *   import { ArmorIQLangChain } from '@armoriq/sdk-dev/integrations/langchain';
 *   import { ArmorIQOpenAI }   from '@armoriq/sdk-dev/integrations/openai';
 *   import { ArmorIQAnthropic } from '@armoriq/sdk-dev/integrations/anthropic';
 *
 * Availability:
 *   google-adk → real            (wraps ADK's BasePlugin)
 *   crewai     → real (port)     (wraps CrewAI Crew.kickoff)
 *   langchain  → Coming Soon
 *   openai     → Coming Soon
 *   anthropic  → Coming Soon
 *
 * Vertex AI: no separate file — Vertex agents run under Google ADK, so
 * ArmorIQADK covers Vertex too.
 */

export { ArmorIQADK, ArmorIQADKOptions } from './google-adk';
export { ArmorIQCrew, ArmorIQCrewOptions } from './crewai';
export { ArmorIQLangChain, ArmorIQLangChainOptions } from './langchain';
export { ArmorIQOpenAI, ArmorIQOpenAIOptions } from './openai';
export { ArmorIQAnthropic, ArmorIQAnthropicOptions } from './anthropic';
