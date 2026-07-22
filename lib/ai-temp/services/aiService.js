/**
 * aiService.js
 * ---------------------------------------------------------------------------
 * SINGLE ENTRY POINT for every AI feature (Resume Analyzer, Resume Rewrite,
 * Career Coach, Cover Letter, Mock Interview, Job Match Score).
 *
 * This file intentionally contains NO feature-specific logic and NO
 * provider-specific integration (no OpenAI/Gemini code). It only wires
 * together the reusable building blocks:
 *
 *   validateRequest  -> sanitizeInput -> providerResolver -> historyService
 *                                                   |
 *                                                   v
 *                                          responseBuilder (standard shape)
 *
 * Usage from a feature controller:
 *
 *   import { runAIFeature } from '../../lib/ai/services/aiService.js';
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
 *       plan: req.usage.plan,               // set by usage middleware
 *       usageRemaining: req.usage.remaining, // set by usage middleware
 *     },
 *   });
 *
 *   res.json(result); // already matches the standardized response shape
 *
 * NOTE: enforcing plan limits (blocking a request because usage is
 * exhausted) is the responsibility of the existing usage middleware /
 * shared limits configuration, which runs BEFORE this service is invoked
 * (Express middleware on the route). This service only *reports*
 * plan/usageRemaining in its response — it does not duplicate
 * limit-enforcement logic.
 *
 * FIX NOTE (stabilization pass): this file previously used CommonJS
 * require()/module.exports under an ESM ("type": "module") project. Any
 * import of this module threw a ReferenceError ("require is not defined")
 * at evaluation time, which every feature controller's dynamic
 * `await import(...)` + try/catch silently swallowed — meaning every AI
 * feature has always run in its local fallback mode, never through this
 * shared service. Converted to ESM; no logic/architecture changes.
 * ---------------------------------------------------------------------------
 */

import { validateAIRequest } from '../validators/validateRequest.js';
import { sanitize } from '../validators/sanitizeInput.js';
import { resolveProvider, invokeProvider } from '../utils/providerResolver.js';
import * as historyService from './historyService.js';
import { buildSuccessResponse, buildErrorResponse } from './responseBuilder.js';

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
 * @returns {Promise<import('./responseBuilder.js').StandardAIResponse>}
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
    return buildErrorResponse({
      message: 'Request failed validation.',
      errors,
      user,
      options,
    });
  }

  // 2. Sanitize the prompt before it touches any prompt template or provider.
  const sanitizedPrompt = sanitize(prompt);

  try {
    // 3. Resolve the active provider (frontend never knows which one this is).
    const { instance } = resolveProvider({ provider: options.provider });

    // 4. Build the final payload sent to the provider. Feature-specific
    //    system instructions are supplied by the caller (built via
    //    lib/ai/prompts/basePrompt.js), not hard-coded here.
    const providerPayload = {
      feature,
      prompt: sanitizedPrompt,
      system: options.systemInstructions || undefined,
      ...(options.providerOptions || {}),
    };

    // 5. Invoke the provider through the normalized adapter.
    const { text: responseText, raw } = await invokeProvider(instance, providerPayload);

    // 6. Best-effort history persistence — never let a history failure
    //    break the actual feature response.
    if (options.saveToHistory) {
      try {
        await historyService.saveHistory({
          user,
          feature,
          prompt: sanitizedPrompt,
          response: responseText,
          metadata: options.historyMetadata,
        });
      } catch (historyErr) {
        // Intentionally swallowed: history is supplementary, not critical path.
        // eslint-disable-next-line no-console
        console.error('[aiService] Failed to save AI history:', historyErr.message);
      }
    }

    // 7. Return the standardized response shape.
    return buildSuccessResponse({
      message: 'AI request completed successfully.',
      data: {
        feature,
        result: responseText,
        raw: options.includeRawProviderResponse ? raw : undefined,
      },
      user,
      options,
    });
  } catch (err) {
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
