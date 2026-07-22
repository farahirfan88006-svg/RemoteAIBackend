import freeProvider from './freeProvider.js';
import openaiProvider from './openaiProvider.js';
import geminiProvider from './geminiProvider.js';

/**
 * Provider registry.
 * ------------------
 * To switch which AI provider the app uses, change ONLY the
 * ACTIVE_PROVIDER value below. Nothing else in the app needs to change,
 * since every consumer imports the default export from this file.
 *
 * Available keys: 'free' | 'openai' | 'gemini'
 */
const ACTIVE_PROVIDER = 'free';

const providers = {
  free: freeProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

const activeProvider = providers[ACTIVE_PROVIDER];

if (!activeProvider) {
  throw new Error(
    `Unknown AI provider "${ACTIVE_PROVIDER}" configured in lib/ai/providers/index.js`
  );
}

// The currently active provider — this is what the rest of the app should import.
export default activeProvider;

// Exposed for tooling/tests that need to inspect all registered providers.
export { providers, ACTIVE_PROVIDER };
