import { AIProvider } from './provider.js';
import { logger } from '../../monitoring/logger.js';

/**
 * GroqProvider
 * ------------
 * Real, network-calling implementation of the AIProvider interface, backed
 * by Groq's OpenAI-compatible Chat Completions API (ultra-low-latency
 * inference for models like Llama 3.x, Mixtral, Gemma, etc.). Uses the
 * platform's native `fetch` — no new HTTP dependency required, same as
 * OpenAIProvider / OpenRouterProvider.
 *
 * Configuration (see .env.example):
 *   GROQ_API_KEY  - required for isAvailable()/generateText() to work.
 *   GROQ_MODEL    - optional, defaults to "llama-3.3-70b-versatile".
 *
 * Same fallback contract as every other provider in this folder:
 * isAvailable() never throws, generateText() throws a clear, descriptive
 * error on missing config or a failed call so the caller
 * (providerResolver.js / aiService.js) can log it and degrade to the free
 * provider instead of the request failing hard.
 */

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqProvider extends AIProvider {
  constructor() {
    super('groq');
  }

  isAvailable() {
    return Boolean(process.env.GROQ_API_KEY);
  }

  /**
   * @param {string} prompt
   * @param {object} [options]
   * @param {string} [options.systemInstructions] - Feature-specific system prompt.
   * @param {string} [options.model] - Overrides GROQ_MODEL/default for this call.
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @returns {Promise<{ text: string, provider: string, raw: object }>}
   */
  async generateText(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error(
        'GroqProvider is not configured: GROQ_API_KEY is missing. Set it in your environment to use this provider.',
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
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: options.model || process.env.GROQ_MODEL || DEFAULT_MODEL,
          messages,
          temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
          max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1000,
        }),
      });
    } catch (networkErr) {
      logger.error('[GroqProvider] Network error calling Groq', { error: networkErr.message });
      throw new Error(`GroqProvider network error: ${networkErr.message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error('[GroqProvider] Non-OK response from Groq', {
        status: response.status,
        body: errorBody.slice(0, 500),
      });
      throw new Error(`Groq API error (${response.status}): ${errorBody.slice(0, 300) || 'no response body'}`);
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

export default new GroqProvider();
