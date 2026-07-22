import { AIProvider } from './provider.js';

/**
 * FreeProvider
 * ------------
 * Placeholder implementation of the AIProvider interface.
 * Makes no external API calls — it exists so the rest of the app has a
 * working, zero-cost default provider while OpenAI/Gemini integrations
 * are not built yet.
 */
export class FreeProvider extends AIProvider {
  constructor() {
    super('free');
  }

  async generateText(prompt, options = {}) {
    // Placeholder response only — no external service is called.
    return {
      text: `[free provider placeholder] No AI model is connected yet. Prompt received: "${prompt}"`,
      provider: this.name,
      raw: null,
    };
  }

  isAvailable() {
    return true;
  }
}

export default new FreeProvider();
