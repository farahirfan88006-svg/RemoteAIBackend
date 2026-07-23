import { AIProvider } from './provider.js';
import { logger } from '../../monitoring/logger.js';

/**
 * OpenAIProvider
 * --------------
 * Real, network-calling implementation of the AIProvider interface, backed
 * by OpenAI's Chat Completions API. Uses the platform's native `fetch`
 * (Node >=18, already required by this project's `engines` field) so no
 * new HTTP dependency is needed.
 *
 * Configuration (see .env.example):
 *   OPENAI_API_KEY  - required for isAvailable()/generateText() to work.
 *   OPENAI_MODEL    - optional, defaults to "gpt-4o-mini".
 *
 * Never throws for missing configuration from isAvailable() — callers
 * (providerResolver.js) are expected to check isAvailable() first and fall
 * back to the free provider rather than invoke generateText() at all.
 * generateText() itself still throws a clear, descriptive error if called
 * anyway (e.g. directly, outside the resolver), or if the API call fails,
 * so the caller can log it and degrade gracefully instead of the process
 * crashing.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider extends AIProvider {
  constructor() {
    super('openai');
  }

  isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  /**
   * @param {string} prompt
   * @param {object} [options]
   * @param {string} [options.systemInstructions] - Feature-specific system prompt.
   * @param {string} [options.model] - Overrides OPENAI_MODEL/default for this call.
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @returns {Promise<{ text: string, provider: string, raw: object }>}
   */
  async generateText(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error(
        'OpenAIProvider is not configured: OPENAI_API_KEY is missing. Set it in your environment to use this provider.',
      );
    }

    const systemInstructions = options.systemInstructions || options.system || '';
    const messages = [];
    if (systemInstructions) {
      messages.push({ role: 'system', content: systemInstructions });
    }
    messages.push({ role: 'user', content: String(prompt ?? '') });

    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: options.model || process.env.OPENAI_MODEL || DEFAULT_MODEL,
          messages,
          temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
          max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1000,
        }),
      });
    } catch (networkErr) {
      logger.error('[OpenAIProvider] Network error calling OpenAI', { error: networkErr.message });
      throw new Error(`OpenAIProvider network error: ${networkErr.message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error('[OpenAIProvider] Non-OK response from OpenAI', {
        status: response.status,
        body: errorBody.slice(0, 500),
      });
      throw new Error(`OpenAI API error (${response.status}): ${errorBody.slice(0, 300) || 'no response body'}`);
    }

    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content || '';
    const usage = json?.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : null;

    return {
      text,
      provider: this.name,
      raw: { model: json.model, usage },
    };
  }
}

export default new OpenAIProvider();
