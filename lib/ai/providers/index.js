import freeProvider from './freeProvider.js';
import openaiProvider from './openai.provider.js';
import geminiProvider from './gemini.provider.js';
import openrouterProvider from './openrouter.provider.js';

/**
 * Provider registry.
 * ------------------
 * Every provider instance in this map implements the shared AIProvider
 * interface (see provider.js): `generateText(prompt, options)`.
 *
 * Phase 11: the real, network-calling implementations now live in
 * openai.provider.js / gemini.provider.js / openrouter.provider.js (each
 * makes no API call — and reports isAvailable() === false — until its
 * corresponding *_API_KEY env var is set). The older openaiProvider.js /
 * geminiProvider.js files are left in place, unused, as they were
 * intentionally-unimplemented placeholders superseded by the files above.
 *
 * lib/ai/utils/providerResolver.js is what actually picks a provider per
 * request (env-driven, with safe fallback to "free"); ACTIVE_PROVIDER here
 * is only a static default for any legacy code that imports this module's
 * default export directly.
 *
 * Available keys: 'free' | 'openai' | 'gemini' | 'openrouter'
 */
const ACTIVE_PROVIDER = 'free';

export const providers = {
  free: freeProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
};

// Never throw here: an unknown/misconfigured ACTIVE_PROVIDER should degrade
// to the always-available free provider rather than crash on import.
const activeProvider = providers[ACTIVE_PROVIDER] || providers.free;

// The currently active provider — this is what the rest of the app should import.
export default activeProvider;

// Exposed for tooling/tests that need to inspect all registered providers.
export { ACTIVE_PROVIDER };
