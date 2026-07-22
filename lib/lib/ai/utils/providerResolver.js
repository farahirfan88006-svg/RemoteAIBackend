/**
 * providerResolver.js
 * ---------------------------------------------------------------------------
 * Chooses the active AI provider from the AI provider registry that already
 * exists at lib/ai/providers/index.js. This module does NOT implement any
 * provider (no OpenAI/Gemini code). It only resolves which already-registered
 * provider instance should handle a given call, and normalizes how it is
 * invoked so the rest of the AI service layer never needs to know which
 * concrete provider is running underneath.
 *
 * Frontend must never know which provider is used: this module is the only
 * place that "chooses", and it always exposes a generic `providerId` alias
 * (e.g. "primary") rather than the real provider name.
 *
 * CONTRACT (implemented in lib/ai/providers/*):
 *   - lib/ai/providers/index.js default-exports the active provider
 *     instance, and named-exports `providers` (a { [name]: instance } map)
 *     and `ACTIVE_PROVIDER` (the active key).
 *   - Every provider instance extends AIProvider (lib/ai/providers/provider.js)
 *     and implements:
 *       async generateText(prompt, options) -> { text, provider, raw }
 *       isAvailable() -> boolean
 *
 * FIX NOTE (stabilization pass): this file previously used CommonJS
 * require()/module.exports while the project is "type": "module" (ESM),
 * and searched for the provider registry under src/ai/providers/* paths
 * that don't exist. Both bugs meant this module could never actually load
 * or resolve a provider, silently forcing every AI feature controller into
 * its local fallback path. Converted to ESM and pointed at the real
 * registry — no behavioral/architectural redesign otherwise.
 * ---------------------------------------------------------------------------
 */

import activeProvider, { providers, ACTIVE_PROVIDER } from '../providers/index.js';

/**
 * Resolves the provider instance to use.
 *
 * @param {Object} [options]
 * @param {string} [options.provider] - Optional explicit provider name
 *   (internal use only, e.g. for admin tooling/testing). Never sourced
 *   from raw frontend input without validation upstream.
 * @returns {{ providerId: string, providerName: string, instance: object }}
 */
function resolveProvider(options = {}) {
  const requestedName =
    options.provider || process.env.AI_DEFAULT_PROVIDER || process.env.DEFAULT_AI_PROVIDER;

  let instance;
  let providerName;

  if (requestedName && Object.prototype.hasOwnProperty.call(providers, requestedName)) {
    instance = providers[requestedName];
    providerName = requestedName;
  } else {
    // No explicit override (or an unknown one) — use the registry's
    // configured active provider.
    instance = activeProvider;
    providerName = ACTIVE_PROVIDER;
  }

  if (!instance) {
    throw new Error(
      `[providerResolver] No active AI provider could be resolved` +
        (requestedName ? ` for "${requestedName}"` : '') +
        '. Confirm lib/ai/providers/index.js has a valid ACTIVE_PROVIDER configured.',
    );
  }

  if (typeof instance.isAvailable === 'function' && !instance.isAvailable()) {
    throw new Error(
      `[providerResolver] Provider "${providerName}" is not currently available.`,
    );
  }

  return {
    // Generic, provider-agnostic identifier — safe to ever surface to a client.
    providerId: 'primary',
    // Real provider name, kept internal (do not put this in API responses).
    providerName: providerName || 'unknown',
    instance,
  };
}

/**
 * Normalizes invocation across provider instances so callers (aiService.js)
 * don't need to know the exact method name. Every current provider
 * implements generateText(prompt, options) per the AIProvider base class,
 * but generate/generateCompletion/complete/run are also accepted so a
 * differently-shaped future provider still works without changes here.
 *
 * @param {object} instance - Provider instance from resolveProvider().
 * @param {object} payload - { prompt, system, ...providerOptions }
 * @returns {Promise<{ text: string, raw: any }>}
 */
async function invokeProvider(instance, payload) {
  const { prompt, ...options } = payload || {};

  const method =
    instance.generateText ||
    instance.generate ||
    instance.generateCompletion ||
    instance.complete ||
    instance.run;

  if (typeof method !== 'function') {
    throw new Error(
      '[providerResolver] Resolved provider instance has no recognized ' +
        'invocation method (generateText/generate/generateCompletion/complete/run). ' +
        'Check the AI provider architecture implementation.',
    );
  }

  const raw = await method.call(instance, prompt, options);

  if (typeof raw === 'string') {
    return { text: raw, raw };
  }

  if (raw && typeof raw === 'object') {
    const text = raw.text || raw.content || raw.output || raw.message || '';
    return { text, raw };
  }

  return { text: '', raw };
}

export { resolveProvider, invokeProvider };

export default {
  resolveProvider,
  invokeProvider,
};
