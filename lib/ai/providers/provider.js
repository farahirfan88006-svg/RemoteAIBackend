/**
 * AIProvider
 * ----------
 * Base interface/abstract class that every AI provider must implement.
 * This defines the common contract so the rest of the app can talk to
 * "the AI provider" without knowing which concrete provider (free,
 * OpenAI, Gemini, ...) is actually active.
 *
 * To add a new provider:
 *   1. Create a new file in lib/ai/providers/ that extends AIProvider.
 *   2. Implement generateText() (and isAvailable()).
 *   3. Register it in lib/ai/providers/index.js.
 *   4. Switch ACTIVE_PROVIDER in index.js to point at it.
 *
 * No provider in this folder currently calls any external AI service.
 */

export class AIProvider {
  /**
   * @param {string} name - identifier for the provider (e.g. "free", "openai", "gemini")
   */
  constructor(name) {
    if (new.target === AIProvider) {
      throw new Error('AIProvider is an abstract class and cannot be instantiated directly.');
    }
    this.name = name;
  }

  /**
   * Generate a text completion/response for a given prompt.
   * Every concrete provider must implement this.
   *
   * @param {string} prompt
   * @param {object} [options]
   * @returns {Promise<{ text: string, provider: string, raw?: any }>}
   */
  // eslint-disable-next-line no-unused-vars
  async generateText(prompt, options = {}) {
    throw new Error(`generateText() not implemented for provider "${this.name}"`);
  }

  /**
   * Whether this provider is currently usable (e.g. has required
   * API keys/config and a real implementation). Stub providers
   * should return false until they are actually wired up.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return false;
  }
}

export default AIProvider;
