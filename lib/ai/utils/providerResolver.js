/**
 * providerResolver.js
 * ---------------------------------------------------------------------------
 * Chooses the active AI provider for a given call and normalizes how it is
 * invoked, so the rest of the AI service layer (aiService.js) never needs
 * to know which concrete provider is running underneath.
 *
 * Frontend must never know which provider is used: this module is the only
 * place that "chooses", and it always exposes a generic `providerId` alias
 * ("primary") rather than the real provider name in anything that could
 * reach a client response.
 *
 * Phase 11 rewrite:
 *   - Previously this file used CommonJS require()/module.exports inside an
 *     ESM ("type": "module") project (see historyService.js's header for
 *     the full story) and searched a list of CANDIDATE_REGISTRY_PATHS that
 *     never actually included lib/ai/providers — so it never resolved a
 *     real provider. It's now plain ESM, wired directly to the real
 *     provider registry in lib/ai/providers/index.js.
 *   - Provider selection is env-driven: AI_PROVIDER (falls back to the
 *     legacy AI_DEFAULT_PROVIDER name reserved in .env.example, then to
 *     "free") picks one of "free" | "openai" | "gemini" | "openrouter" |
 *     "groq".
 *   - Selection never crashes the API: an unrecognized provider name, or a
 *     recognized one that reports isAvailable() === false (e.g. missing
 *     API key), silently falls back to the always-available "free"
 *     provider, with a warning logged for observability.
 *   - Adding a new provider (e.g. groq.provider.js) never requires a change
 *     here: this file resolves purely by looking up `providers[name]` from
 *     the registry in lib/ai/providers/index.js, so AI_PROVIDER=<key>
 *     works for any key registered there.
 */

import { providers } from '../providers/index.js';
import { logger } from '../../monitoring/logger.js';

const FALLBACK_PROVIDER_NAME = 'free';

function normalizeProviderName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * Resolves the provider instance to use for a call.
 *
 * @param {Object} [options]
 * @param {string} [options.provider] - Optional explicit provider name
 *   (internal use only, e.g. for admin tooling/testing/background jobs).
 *   Never sourced from raw frontend input without validation upstream.
 * @returns {{ providerId: string, providerName: string, instance: object }}
 */
export function resolveProvider(options = {}) {
  const requestedName =
    normalizeProviderName(options.provider) ||
    normalizeProviderName(process.env.AI_PROVIDER) ||
    normalizeProviderName(process.env.AI_DEFAULT_PROVIDER) ||
    FALLBACK_PROVIDER_NAME;

  let providerName = requestedName;
  let instance = providers[providerName];

  if (!instance) {
    logger.warn(`[providerResolver] Unknown AI provider "${requestedName}" — falling back to "${FALLBACK_PROVIDER_NAME}".`);
    providerName = FALLBACK_PROVIDER_NAME;
    instance = providers[FALLBACK_PROVIDER_NAME];
  } else if (
    providerName !== FALLBACK_PROVIDER_NAME &&
    typeof instance.isAvailable === 'function' &&
    !instance.isAvailable()
  ) {
    logger.warn(
      `[providerResolver] AI provider "${providerName}" is not available (missing API key/config) — falling back to "${FALLBACK_PROVIDER_NAME}".`,
    );
    providerName = FALLBACK_PROVIDER_NAME;
    instance = providers[FALLBACK_PROVIDER_NAME];
  }

  if (!instance) {
    // Only reachable if the free provider itself was removed from the
    // registry — never crash the request, but this is a real config bug.
    throw new Error(
      '[providerResolver] No AI provider could be resolved, including the "free" fallback. Check lib/ai/providers/index.js.',
    );
  }

  return {
    // Generic, provider-agnostic identifier — safe to ever surface to a client.
    providerId: 'primary',
    // Real provider name, safe for internal logging/history — do not put
    // raw provider identity in anything served back to the frontend as-is.
    providerName,
    instance,
  };
}

/**
 * Normalizes invocation of a resolved provider instance so callers
 * (aiService.js) don't need to know the exact response shape.
 *
 * @param {object} instance - Provider instance from resolveProvider().
 * @param {object} payload - { prompt, system|systemInstructions, ...providerOptions }
 * @returns {Promise<{ text: string, raw: any }>}
 */
export async function invokeProvider(instance, payload = {}) {
  if (!instance || typeof instance.generateText !== 'function') {
    throw new Error(
      '[providerResolver] Resolved provider instance does not implement generateText(). Check the AI provider architecture implementation.',
    );
  }

  const { prompt, system, systemInstructions, ...providerOptions } = payload;
  const options = { ...providerOptions, systemInstructions: systemInstructions || system };

  const raw = await instance.generateText(prompt, options);

  if (typeof raw === 'string') {
    return { text: raw, raw };
  }

  if (raw && typeof raw === 'object') {
    const text = raw.text || raw.content || raw.output || raw.message || '';
    return { text, raw };
  }

  return { text: '', raw };
}

export default {
  resolveProvider,
  invokeProvider,
};
