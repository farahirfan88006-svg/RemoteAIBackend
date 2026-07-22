import { AIProvider } from './provider.js';

/**
 * OpenAIProvider
 * --------------
 * Empty stub. No integration with OpenAI has been implemented yet.
 * Intentionally makes no network calls.
 */
export class OpenAIProvider extends AIProvider {
  constructor() {
    super('openai');
    // TODO: read OPENAI_API_KEY (and any model/config options) from env once integration is built.
  }

  async generateText(prompt, options = {}) {
    // TODO: implement request to OpenAI's chat/completions API and map the response
    // to the shared { text, provider, raw } shape defined in provider.js.
    throw new Error('OpenAIProvider.generateText() is not implemented yet.');
  }

  isAvailable() {
    // TODO: return true once the API key is configured and the integration above is implemented.
    return false;
  }
}

export default new OpenAIProvider();
