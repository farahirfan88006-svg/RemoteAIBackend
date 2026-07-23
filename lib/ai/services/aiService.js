/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * SINGLE ENTRY POINT for every AI feature (Resume Analyzer, Resume Rewrite,
 * Career Coach, Cover Letter AI, Mock Interview AI, Job Match Score, etc.).
 *
 * This file intentionally contains NO feature-specific logic and NO
 * provider-specific integration (no OpenAI/Gemini/OpenRouter code — that
 * lives in lib/ai/providers/*). It wires together the reusable building
 * blocks:
 *
 *   validateRequest -> sanitizeInput -> aiCache (check) -> providerResolver
 *                                                                 |
 *                                    historyService  <---  invokeProvider
 *                                          |                      |
 *                                          v                      v
 *                                   aiCache (save)      responseBuilder (standard shape)
 *
 * Usage from a feature controller:
 *
 *   const { runAIFeature } = await import('../../../lib/ai/services/aiService.js');
 *
 *   const result = await runAIFeature({
 *     feature: 'resumeAnalyzer',
 *     user: req.user,              // already populated by auth + usage middleware
 *     prompt: req.body.resumeText,
 *     options: {
 *       supportedFeatures: ['resumeAnalyzer', 'careerCoach', ...], // feature registry
 *       maxLength: 12000,
 *       systemInstructions: '...',  // feature-specific, built with basePrompt.js
 *       saveToHistory: true,
 *       plan: req.user.plan,               // usually set by usage middleware
 *       usageRemaining: req.usage.remaining, // usually set by usage middleware
 *     },
 *   });
 *
 *   res.json(result); // already matches the standardized response shape
 *
 * NOTE: enforcing plan limits (blocking a request because usage is
 * exhausted) is the responsibility of the existing usage middleware /
 * shared limits configuration, which is expected to run BEFORE this
 * service is invoked (e.g. as Express middleware on the route). This
 * service only *reports* plan/usageRemaining in its response — it does not
 * duplicate limit-enforcement logic.
 *
 * Phase 11 changes:
 *   - Converted from CommonJS to ESM (see historyService.js's header for
 *     why this was necessary for the service to run at all).
 *   - Added an AI response cache check/save around the provider call
 *     (lib/cache/aiCache.js), keyed by userId + feature + input hash.
 *   - Added AI call metrics/token-usage tracking (lib/monitoring/metrics.js)
 *     and structured error logging (lib/monitoring/logger.js).
 *   - If the resolved provider fails at call time (network/auth error) and
 *     it isn't already the "free" provider, this now retries once against
 *     the free provider before giving up, so a transient real-provider
 *     outage degrades gracefully instead of failing the whole request.
 */

import { validateAIRequest } from '../validators/validateRequest.js';
import { sanitize } from '../validators/sanitizeInput.js';
import { resolveProvider, invokeProvider } from '../utils/providerResolver.js';
import * as historyService from './historyService.js';
import { buildSuccessResponse, buildErrorResponse } from './responseBuilder.js';
import { getCachedResponse, setCachedResponse } from '../../cache/aiCache.js';
import { logger } from '../../monitoring/logger.js';
import { recordAICall } from '../../monitoring/metrics.js';

function getUserId(user) {
  if (!user) return null;
  return user._id || user.id || user.userId || null;
}

function buildCacheInput(sanitizedPrompt, options) {
  return `${options.systemInstructions || ''}::${sanitizedPrompt}`;
}

function extractTokenCount(raw) {
  return raw?.raw?.usage?.totalTokens ?? raw?.usage?.totalTokens ?? null;
}

/**
 * @param {Object} params
 * @param {string} params.feature - Feature key, e.g. "resumeAnalyzer".
 * @param {Object} params.user - Authenticated user (populated by existing auth/usage middleware).
 * @param {string} params.prompt - Raw user-provided input for this feature.
 * @param {Object} [params.options]
 * @param {string[]} [params.options.supportedFeatures] - Registry of currently-enabled feature keys.
 * @param {number} [params.options.maxLength] - Max allowed prompt length for this call.
 * @param {string} [params.options.systemInstructions] - Feature-specific system prompt (built via basePrompt.js).
 * @param {string} [params.options.provider] - Optional explicit provider override (internal/testing use).
 * @param {boolean} [params.options.saveToHistory=false] - Whether to persist this interaction via historyService.
 * @param {string} [params.options.plan] - Plan label, typically set upstream by usage middleware.
 * @param {number} [params.options.usageRemaining] - Remaining usage, typically set upstream by usage middleware.
 * @param {Object} [params.options.providerOptions] - Passed through verbatim to the provider call.
 * @param {boolean} [params.options.skipCache=false] - Bypass cache read/write for this call.
 * @returns {Promise<import('./responseBuilder').StandardAIResponse>}
 */
export async function runAIFeature({ feature, user, prompt, options = {} } = {}) {
  // 1. Validate the incoming request shape/content.
  const { valid, errors } = validateAIRequest({
    feature,
    prompt,
    options,
    supportedFeatures: options.supportedFeatures,
    maxLength: options.maxLength,
  });

  if (!valid) {
    return buildErrorResponse({ message: 'Request failed validation.', errors, user, options });
  }

  // 2. Sanitize the prompt before it touches any prompt template, cache key, or provider.
  const sanitizedPrompt = sanitize(prompt);
  const userId = getUserId(user);
  const cacheInput = buildCacheInput(sanitizedPrompt, options);

  try {
    // 3. Check the AI response cache before calling any provider.
    if (!options.skipCache) {
      const cached = await getCachedResponse(userId, feature, cacheInput);
      if (cached) {
        recordAICall({ feature, provider: cached.provider || 'cache', success: true, tokens: null });
        return buildSuccessResponse({
          message: 'AI request completed successfully.',
          data: { feature, result: cached.result, cached: true },
          user,
          options,
        });
      }
    }

    // 4. Resolve the active provider (frontend never knows which one this is).
    const { providerName, instance } = resolveProvider({ provider: options.provider });

    // 5. Build the final payload sent to the provider. Feature-specific
    //    system instructions are supplied by the caller (built via
    //    lib/ai/prompts/basePrompt.js), not hard-coded here.
    const providerPayload = {
      feature,
      prompt: sanitizedPrompt,
      system: options.systemInstructions || undefined,
      ...(options.providerOptions || {}),
    };

    // 6. Invoke the provider through the normalized adapter. If the
    //    configured provider fails at call time and it isn't already the
    //    free fallback, retry once against the free provider so a
    //    transient outage/misconfiguration degrades gracefully instead of
    //    failing the whole request.
    let activeProviderName = providerName;
    let responseText;
    let raw;

    try {
      ({ text: responseText, raw } = await invokeProvider(instance, providerPayload));
    } catch (providerErr) {
      logger.error(`[aiService] Provider "${providerName}" failed`, { feature, error: providerErr.message });

      if (providerName === 'free') {
        throw providerErr;
      }

      const fallback = resolveProvider({ provider: 'free' });
      activeProviderName = fallback.providerName;
      ({ text: responseText, raw } = await invokeProvider(fallback.instance, providerPayload));
    }

    // 7. Track AI call metrics (count, error rate, token usage when reported).
    recordAICall({ feature, provider: activeProviderName, success: true, tokens: extractTokenCount(raw) });

    // 8. Best-effort history persistence — never let a history failure
    //    break the actual feature response.
    if (options.saveToHistory) {
      try {
        await historyService.saveHistory({
          user,
          feature,
          prompt: sanitizedPrompt,
          response: responseText,
          provider: activeProviderName,
        });
      } catch (historyErr) {
        // Intentionally swallowed: history is supplementary, not critical path.
        logger.error('[aiService] Failed to save AI history', { feature, error: historyErr.message });
      }
    }

    // 9. Save the successful response to cache for future identical requests.
    if (!options.skipCache) {
      await setCachedResponse(userId, feature, cacheInput, { result: responseText, provider: activeProviderName });
    }

    // 10. Return the standardized response shape.
    return buildSuccessResponse({
      message: 'AI request completed successfully.',
      data: {
        feature,
        result: responseText,
        cached: false,
        raw: options.includeRawProviderResponse ? raw : undefined,
      },
      user,
      options,
    });
  } catch (err) {
    recordAICall({ feature, provider: options.provider || 'unknown', success: false, tokens: null });
    logger.error('[aiService] AI request failed', { feature, error: err && err.message });
    return buildErrorResponse({
      message: 'AI request failed.',
      errors: [err && err.message ? err.message : 'Unknown error occurred.'],
      user,
      options,
    });
  }
}

export default {
  runAIFeature,
};
