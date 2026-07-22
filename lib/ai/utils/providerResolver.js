/**
 * providerResolver.js
 * ---------------------------------------------------------------------------
 * Chooses the active AI provider from the AI provider architecture that
 * already exists in this codebase. This module does NOT implement any
 * provider (no OpenAI/Gemini code). It only resolves which already-registered
 * provider instance should handle a given call, and normalizes how it is
 * invoked so the rest of the AI service layer never needs to know which
 * concrete provider is running underneath.
 *
 * Frontend must never know which provider is used: this module is the only
 * place that "chooses", and it always exposes a generic `providerId` alias
 * (e.g. "primary") rather than the real provider name.
 *
 * ASSUMED CONTRACT (already implemented elsewhere in this repo):
 *   The provider registry exposes, in some form, either:
 *     - getProvider(name) => providerInstance
 *     - a map/object of { [name]: providerInstance }
 *   Each providerInstance exposes ONE of the following async methods:
 *     - generate(payload)
 *     - generateCompletion(payload)
 *     - complete(payload)
 *     - run(payload)
 *   returning either a string, or an object containing one of:
 *     { text | content | output | message }
 *
 * INTEGRATION NOTE:
 * If your existing provider registry lives at a different path than the
 * candidates below, add it to CANDIDATE_REGISTRY_PATHS (first match wins).
 * Nothing else in lib/ai needs to change.
 */

'use strict';

const CANDIDATE_REGISTRY_PATHS = [
  '../../../src/ai/providers',
  '../../../src/ai/providers/registry',
  '../../../src/ai/providerRegistry',
  '../../../src/services/ai/providers',
  '../../../src/services/ai/providerRegistry',
  '../../../src/providers',
  '../../../src/providers/registry',
  '../../../src/config/providers',
];

let cachedRegistryModule = null;
let cachedRegistryError = null;

function loadRegistryModule() {
  if (cachedRegistryModule || cachedRegistryError) {
    return cachedRegistryModule;
  }

  for (const candidate of CANDIDATE_REGISTRY_PATHS) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      cachedRegistryModule = require(candidate);
      return cachedRegistryModule;
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') {
        cachedRegistryError = err;
        throw err;
      }
    }
  }

  cachedRegistryError = new Error(
    '[providerResolver] Could not locate the existing AI provider registry. ' +
      'Update CANDIDATE_REGISTRY_PATHS in lib/ai/utils/providerResolver.js ' +
      'to point at your provider architecture module.'
  );
  throw cachedRegistryError;
}

/**
 * Extracts a usable provider instance + name from whatever shape the
 * existing registry module exports.
 */
function getRegistryEntries(registryModule) {
  const mod = registryModule && registryModule.default ? registryModule.default : registryModule;

  if (mod && typeof mod.getProvider === 'function') {
    return { type: 'function', mod };
  }

  if (mod && typeof mod.getActiveProvider === 'function') {
    return { type: 'active-function', mod };
  }

  if (mod && typeof mod === 'object') {
    return { type: 'map', mod };
  }

  throw new Error(
    '[providerResolver] Provider registry module was found but has an ' +
      'unrecognized shape. Expected getProvider(name), getActiveProvider(), ' +
      'or a { name: providerInstance } map.'
  );
}

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
  const registryModule = loadRegistryModule();
  const { type, mod } = getRegistryEntries(registryModule);

  const requestedName =
    options.provider || process.env.AI_DEFAULT_PROVIDER || process.env.DEFAULT_AI_PROVIDER;

  let instance = null;
  let providerName = requestedName || 'default';

  if (type === 'function') {
    instance = mod.getProvider(requestedName);
    if (!instance && !requestedName) {
      // Try common "default" fallbacks used by registry implementations.
      instance = mod.getProvider('default') || mod.getProvider();
    }
  } else if (type === 'active-function') {
    instance = mod.getActiveProvider(requestedName);
  } else if (type === 'map') {
    providerName = requestedName && mod[requestedName] ? requestedName : Object.keys(mod)[0];
    instance = mod[providerName];
  }

  if (!instance) {
    throw new Error(
      `[providerResolver] No active AI provider could be resolved` +
        (requestedName ? ` for "${requestedName}"` : '') +
        '. Confirm the provider registry has at least one provider registered.'
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
 * Normalizes invocation across differently-shaped provider instances so
 * callers (aiService.js) don't need to know the exact method name.
 *
 * @param {object} instance - Provider instance from resolveProvider().
 * @param {object} payload - { prompt, options }
 * @returns {Promise<{ text: string, raw: any }>}
 */
async function invokeProvider(instance, payload) {
  const method =
    instance.generate ||
    instance.generateCompletion ||
    instance.complete ||
    instance.run;

  if (typeof method !== 'function') {
    throw new Error(
      '[providerResolver] Resolved provider instance has no recognized ' +
        'invocation method (generate/generateCompletion/complete/run). ' +
        'Check the AI provider architecture implementation.'
    );
  }

  const raw = await method.call(instance, payload);

  if (typeof raw === 'string') {
    return { text: raw, raw };
  }

  if (raw && typeof raw === 'object') {
    const text = raw.text || raw.content || raw.output || raw.message || '';
    return { text, raw };
  }

  return { text: '', raw };
}

module.exports = {
  resolveProvider,
  invokeProvider,
};
