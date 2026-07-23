import { AIProvider } from './provider.js';
import { logger } from '../../monitoring/logger.js';

/**
 * GeminiProvider
 * --------------
 * Real, network-calling implementation of the AIProvider interface, backed
 * by Google's Gemini generateContent API. Uses the platform's native
 * `fetch` — no new HTTP dependency required.
 *
 * Configuration (see .env.example):
 *   GEMINI_API_KEY  - required for isAvailable()/generateText() to work.
 *   GEMINI_MODEL    - optional, defaults to "gemini-1.5-flash".
 *
 * Same fallback contract as OpenAIProvider: isAvailable() never throws,
 * generateText() throws a clear, descriptive error on missing config or a
 * failed call so the caller (providerResolver.js / aiService.js) can log it
 * and degrade to the free provider instead of the request failing hard.
 */

const DEFAULT_MODEL = 'gemini-1.5-flash';

function buildApiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

export class GeminiProvider extends AIProvider {
  constructor() {
    super('gemini');
  }

  isAvailable() {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /**
   * @param {string} prompt
   * @param {object} [options]
   * @param {string} [options.systemInstructions] - Feature-specific system prompt.
   * @param {string} [options.model] - Overrides GEMINI_MODEL/default for this call.
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @returns {Promise<{ text: string, provider: string, raw: object }>}
   */
  async generateText(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error(
        'GeminiProvider is not configured: GEMINI_API_KEY is missing. Set it in your environment to use this provider.',
      );
    }

    const systemInstructions = options.systemInstructions || options.system || '';
    const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;

    const body = {
      contents: [{ role: 'user', parts: [{ text: String(prompt ?? '') }] }],
      generationConfig: {
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
        maxOutputTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1000,
      },
    };
    if (systemInstructions) {
      body.systemInstruction = { role: 'system', parts: [{ text: systemInstructions }] };
    }

    let response;
    try {
      response = await fetch(buildApiUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      logger.error('[GeminiProvider] Network error calling Gemini', { error: networkErr.message });
      throw new Error(`GeminiProvider network error: ${networkErr.message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error('[GeminiProvider] Non-OK response from Gemini', {
        status: response.status,
        body: errorBody.slice(0, 500),
      });
      throw new Error(`Gemini API error (${response.status}): ${errorBody.slice(0, 300) || 'no response body'}`);
    }

    const json = await response.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
    const usage = json?.usageMetadata
      ? {
          promptTokens: json.usageMetadata.promptTokenCount,
          completionTokens: json.usageMetadata.candidatesTokenCount,
          totalTokens: json.usageMetadata.totalTokenCount,
        }
      : null;

    return {
      text,
      provider: this.name,
      raw: { model, usage },
    };
  }
}

export default new GeminiProvider();
