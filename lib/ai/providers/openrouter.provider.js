import { AIProvider } from './provider.js';
import { logger } from '../../monitoring/logger.js';

/**
 * OpenRouterProvider
 * ------------------
 * Real, network-calling implementation of the AIProvider interface, backed
 * by OpenRouter's OpenAI-compatible Chat Completions API — gives access to
 * many underlying models (Claude, Llama, Mistral, etc.) through one key.
 * Uses the platform's native `fetch` — no new HTTP dependency required.
 *
 * Configuration (see .env.example):
 *   OPENROUTER_API_KEY  - required for isAvailable()/generateText() to work.
 *   OPENROUTER_MODEL    - optional, defaults to "openai/gpt-4o-mini".
 *
 * Same fallback contract as the other providers: isAvailable() never
 * throws, generateText() throws a clear, descriptive error on missing
 * config or a failed call so the caller can log it and degrade to the
 * free provider instead of the request failing hard.
 */

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterProvider extends AIProvider {
  constructor() {
    super('openrouter');
  }

  isAvailable() {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }

  /**
   * @param {string} prompt
   * @param {object} [options]
   * @param {string} [options.systemInstructions] - Feature-specific system prompt.
   * @param {string} [options.model] - Overrides OPENROUTER_MODEL/default for this call.
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @returns {Promise<{ text: string, provider: string, raw: object }>}
   */
  async generateText(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error(
        'OpenRouterProvider is not configured: OPENROUTER_API_KEY is missing. Set it in your environment to use this provider.',
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
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          // Optional but recommended by OpenRouter for attribution/analytics.
          'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://remoteai.app',
          'X-Title': process.env.OPENROUTER_APP_NAME || 'RemoteAI',
        },
        body: JSON.stringify({
          model: options.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
          messages,
          temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
          max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1000,
        }),
      });
    } catch (networkErr) {
      logger.error('[OpenRouterProvider] Network error calling OpenRouter', { error: networkErr.message });
      throw new Error(`OpenRouterProvider network error: ${networkErr.message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error('[OpenRouterProvider] Non-OK response from OpenRouter', {
        status: response.status,
        body: errorBody.slice(0, 500),
      });
      throw new Error(`OpenRouter API error (${response.status}): ${errorBody.slice(0, 300) || 'no response body'}`);
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

export default new OpenRouterProvider();
