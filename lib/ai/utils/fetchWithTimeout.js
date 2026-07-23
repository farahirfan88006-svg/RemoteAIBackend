/**
 * lib/ai/utils/fetchWithTimeout.js
 * ---------------------------------------------------------------------------
 * Small shared helper used only by the real, network-calling AI providers
 * (openai/gemini/openrouter/groq) so a hung upstream request can't stall a
 * request indefinitely. Wraps the platform `fetch` with an AbortController
 * timeout and normalizes an abort into a clear, descriptive error so callers
 * can keep treating it exactly like any other network error (log it, fall
 * back to the free provider).
 *
 * Configurable via AI_PROVIDER_TIMEOUT_MS (defaults to 20s). Does not change
 * any existing fallback/error-handling contract — it's just another way a
 * provider call can fail before generateText() returns/throws.
 */

const DEFAULT_TIMEOUT_MS = 20000;

export function getProviderTimeoutMs() {
  const configured = Number(process.env.AI_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

/**
 * @param {string} url
 * @param {object} options - standard fetch options
 * @param {string} providerLabel - used only for the timeout error message, e.g. "OpenAIProvider"
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, providerLabel = 'AIProvider') {
  const timeoutMs = getProviderTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${providerLabel} request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export default fetchWithTimeout;
