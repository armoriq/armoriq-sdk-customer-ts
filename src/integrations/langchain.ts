/**
 * ArmorIQ — LangChain integration. (Coming Soon)
 *
 * Planned surface mirrors the Python SDK's ArmorIQLangChain (currently
 * stubbed in Python too). When implemented, this will wrap LangChain.js
 * `StructuredTool` / `Tool` instances so their `invoke()` routes through
 * the Armoriq proxy via ArmorIQSession.
 *
 * Requires: `npm install @langchain/core langchain`
 */

import { ArmorIQClient } from '../client';

export interface ArmorIQLangChainOptions {
  armoriqClient: ArmorIQClient;
  llm?: string;
  [key: string]: any;
}

export class ArmorIQLangChain {
  constructor(_options: ArmorIQLangChainOptions) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@langchain/core');
    } catch {
      throw new Error(
        '@langchain/core is not installed.\n' +
          'Install it with: npm install @langchain/core langchain',
      );
    }
    throw new Error('ArmorIQ LangChain integration is not yet implemented.');
  }
}
