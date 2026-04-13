/**
 * ArmorIQ — OpenAI integration. (Coming Soon)
 *
 * Mirrors the Python SDK's ArmorIQOpenAI stub. When implemented, this
 * will wrap the OpenAI SDK's tool-call dispatch (and/or the OpenAI
 * Agents runtime) so tool calls route through the Armoriq proxy via
 * ArmorIQSession.
 *
 * Requires: `npm install openai`
 */

import { ArmorIQClient } from '../client';

export interface ArmorIQOpenAIOptions {
  armoriqClient: ArmorIQClient;
  [key: string]: any;
}

export class ArmorIQOpenAI {
  constructor(_options: ArmorIQOpenAIOptions) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('openai');
    } catch {
      throw new Error(
        'openai is not installed.\n' +
          'Install it with: npm install openai',
      );
    }
    throw new Error('ArmorIQ OpenAI integration is not yet implemented.');
  }
}
