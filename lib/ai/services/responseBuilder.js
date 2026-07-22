/**
 * responseBuilder.js
 * ---------------------------------------------------------------------------
 * Guarantees every AI feature — present and future — returns the exact same
 * standardized response shape:
 *
 *   {
 *     success: boolean,
 *     message: string,
 *     plan: string|null,
 *     usageRemaining: number|null,
 *     data: object|null,
 *     errors: string[]
 *   }
 *
 * No feature-specific fields are added here. Feature modules should put
 * anything extra inside `data`.
 */

'use strict';

/**
 * @typedef {Object} StandardAIResponse
 * @property {boolean} success
 * @property {string} message
 * @property {string|null} plan
 * @property {number|null} usageRemaining
 * @property {Object|null} data
 * @property {string[]} errors
 */

/**
 * Pulls plan/usageRemaining off of whatever the usage middleware / shared
 * limits configuration already attached to the request-scoped user or
 * options object, without assuming one exact field name — the usage
 * middleware is assumed to already exist, this just reads its output.
 *
 * @param {Object} [user]
 * @param {Object} [options]
 * @returns {{ plan: string|null, usageRemaining: number|null }}
 */
function extractUsageContext(user, options) {
  const plan =
    (options && options.plan) ||
    (user && (user.plan || (user.subscription && user.subscription.plan))) ||
    null;

  const usageRemainingRaw =
    (options && options.usageRemaining) ??
    (user && (user.usageRemaining ?? (user.usage && user.usage.remaining))) ??
    null;

  const usageRemaining =
    typeof usageRemainingRaw === 'number' && !Number.isNaN(usageRemainingRaw)
      ? usageRemainingRaw
      : null;

  return { plan: plan || null, usageRemaining };
}

/**
 * Builds a successful standardized response.
 *
 * @param {Object} params
 * @param {string} [params.message='Request completed successfully.']
 * @param {Object} [params.data=null] - Feature-specific payload.
 * @param {Object} [params.user] - Used to derive plan/usageRemaining if not passed explicitly.
 * @param {Object} [params.options] - May carry explicit plan/usageRemaining set by usage middleware.
 * @returns {StandardAIResponse}
 */
function buildSuccessResponse({ message, data = null, user, options } = {}) {
  const { plan, usageRemaining } = extractUsageContext(user, options);

  return {
    success: true,
    message: message || 'Request completed successfully.',
    plan,
    usageRemaining,
    data: data ?? null,
    errors: [],
  };
}

/**
 * Builds a failed standardized response. Accepts either a single message
 * or an array of error strings (e.g. from validateRequest.js).
 *
 * @param {Object} params
 * @param {string} [params.message='Request failed.']
 * @param {string|string[]} [params.errors]
 * @param {Object} [params.user]
 * @param {Object} [params.options]
 * @returns {StandardAIResponse}
 */
function buildErrorResponse({ message, errors, user, options } = {}) {
  const { plan, usageRemaining } = extractUsageContext(user, options);

  const normalizedErrors = Array.isArray(errors)
    ? errors
    : errors
    ? [errors]
    : [];

  return {
    success: false,
    message: message || normalizedErrors[0] || 'Request failed.',
    plan,
    usageRemaining,
    data: null,
    errors: normalizedErrors,
  };
}

module.exports = {
  buildSuccessResponse,
  buildErrorResponse,
};
