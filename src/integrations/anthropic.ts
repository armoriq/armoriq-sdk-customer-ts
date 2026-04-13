/**
 * ArmorIQ — Anthropic integration. (Coming Soon)
 *
 * Mirrors the Python SDK's ArmorIQAnthropic stub. When implemented,
 * this will inspect tool_use blocks in Anthropic SDK responses and
 * route each through the Armoriq proxy via ArmorIQSession.
 *
 * Requires: `npm install @anthropic-ai/sdk`
 */

import { ArmorIQClient } from '../client';

export interface ArmorIQAnthropicOptions {
  armoriqClient: ArmorIQClient;
  [key: string]: any;
}

export class ArmorIQAnthropic {
  constructor(_options: ArmorIQAnthropicOptions) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@anthropic-ai/sdk');
    } catch {
      throw new Error(
        '@anthropic-ai/sdk is not installed.\n' +
          'Install it with: npm install @anthropic-ai/sdk',
      );
    }
    throw new Error('ArmorIQ Anthropic integration is not yet implemented.');
  }
}
