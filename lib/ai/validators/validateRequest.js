/**
 * validateRequest.js
 * ---------------------------------------------------------------------------
 * Reusable, feature-agnostic validation helpers shared by every AI feature.
 * These functions are intentionally generic (no Resume Analyzer / Career
 * Coach / etc. specific rules) so future features can compose them.
 *
 * Two usage styles are supported:
 *   1. Individual predicate/assert helpers (isEmpty, assertMaxLength, ...)
 *   2. `validateAIRequest()` — a single aggregator used by aiService.js that
 *      collects ALL validation problems into an errors array matching the
 *      shape responseBuilder expects, instead of throwing on the first
 *      failure.
 */

export const DEFAULT_MAX_PROMPT_LENGTH = 8000;

export class ValidationError extends Error {
  /**
   * @param {string[]} errors - Human-readable validation messages.
   */
  constructor(errors) {
    super(errors && errors[0] ? errors[0] : 'Validation failed');
    this.name = 'ValidationError';
    this.errors = errors || [];
  }
}

/**
 * @param {*} value
 * @returns {boolean} true if value is null/undefined/empty string (after trim)
 */
export function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * @param {*} value
 * @param {number} maxLength
 * @returns {boolean} true if value exceeds maxLength
 */
export function exceedsMaxLength(value, maxLength) {
  if (typeof value !== 'string') return false;
  return value.length > maxLength;
}

/**
 * @param {string} feature
 * @param {string[]} supportedFeatures - registry of currently-enabled feature keys
 * @returns {boolean} true if feature is missing or not in supportedFeatures
 */
export function isUnsupportedFeature(feature, supportedFeatures) {
  if (isEmpty(feature)) return true;
  if (!Array.isArray(supportedFeatures) || supportedFeatures.length === 0) {
    // No registry provided means aiService hasn't been told what's enabled;
    // treat as "cannot verify" -> caller should still explicitly whitelist.
    return true;
  }
  return !supportedFeatures.includes(feature);
}

/**
 * Basic structural check that a payload is a plain, serializable object.
 * Guards against arrays, class instances with circular refs, functions, etc.
 * being passed in as `options`.
 * @param {*} payload
 * @returns {boolean} true if payload is invalid
 */
export function isInvalidPayload(payload) {
  if (payload === null || payload === undefined) return false; // optional is fine
  if (typeof payload !== 'object' || Array.isArray(payload)) return true;

  try {
    JSON.stringify(payload);
    return false;
  } catch (err) {
    return true;
  }
}

/**
 * Aggregates all standard checks for a single AI request into one call.
 * Never throws — returns { valid, errors } so aiService.js can decide how
 * to surface failures via responseBuilder.
 *
 * @param {Object} params
 * @param {string} params.feature
 * @param {string} params.prompt
 * @param {Object} [params.options]
 * @param {string[]} params.supportedFeatures
 * @param {number} [params.maxLength]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAIRequest({
  feature,
  prompt,
  options,
  supportedFeatures,
  maxLength = DEFAULT_MAX_PROMPT_LENGTH,
} = {}) {
  const errors = [];

  if (isUnsupportedFeature(feature, supportedFeatures)) {
    errors.push(`Unsupported or unregistered AI feature: "${feature || 'unknown'}".`);
  }

  if (isEmpty(prompt)) {
    errors.push('Prompt input cannot be empty.');
  } else if (exceedsMaxLength(prompt, maxLength)) {
    errors.push(`Prompt input exceeds maximum length of ${maxLength} characters.`);
  }

  if (isInvalidPayload(options)) {
    errors.push('Invalid options payload: must be a plain, serializable object.');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Throwing variant of validateAIRequest for callers that prefer exceptions.
 * @throws {ValidationError}
 */
export function assertValidAIRequest(params) {
  const { valid, errors } = validateAIRequest(params);
  if (!valid) {
    throw new ValidationError(errors);
  }
}

export default {
  DEFAULT_MAX_PROMPT_LENGTH,
  ValidationError,
  isEmpty,
  exceedsMaxLength,
  isUnsupportedFeature,
  isInvalidPayload,
  validateAIRequest,
  assertValidAIRequest,
};
