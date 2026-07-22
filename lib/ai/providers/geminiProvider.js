import { AIProvider } from './provider.js';

/**
 * GeminiProvider
 * --------------
 * Empty stub. No integration with Google Gemini has been implemented yet.
 * Intentionally makes no network calls.
 */
export class GeminiProvider extends AIProvider {
  constructor() {
    super('gemini');
    // TODO: read GEMINI_API_KEY (and any model/config options) from env once integration is built.
  }

  async generateText(prompt, options = {}) {
    // TODO: implement request to the Gemini API and map the response
    // to the shared { text, provider, raw } shape defined in provider.js.
    throw new Error('GeminiProvider.generateText() is not implemented yet.');
  }

  isAvailable() {
    // TODO: return true once the API key is configured and the integration above is implemented.
    return false;
  }
}

export default new GeminiProvider();
