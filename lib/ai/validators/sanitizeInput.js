/**
 * sanitizeInput.js
 * ---------------------------------------------------------------------------
 * Reusable, feature-agnostic sanitization helpers for anything that will be
 * sent to an AI provider. No feature-specific logic lives here — every
 * future AI feature (Resume Analyzer, Career Coach, etc.) should route raw
 * user text through `sanitize()` before it reaches aiService/prompts.
 */

'use strict';

/**
 * Removes leading/trailing whitespace, including on every line, while
 * preserving intentional internal blank lines.
 * @param {string} value
 * @returns {string}
 */
function trimWhitespace(value) {
  if (typeof value !== 'string') return value;
  return value.trim();
}

/**
 * Normalizes all line endings (\r\n, \r) to \n so downstream length checks
 * and prompt templating behave consistently across platforms.
 * @param {string} value
 * @returns {string}
 */
function normalizeLineEndings(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Strips dangerous/invisible control characters that have no legitimate
 * place in user-submitted text (keeps \n and \t since those are meaningful
 * for formatted input like resumes/cover letters).
 *
 * Removes: C0 control chars (except \n \t), DEL, and common zero-width /
 * bidi-override unicode characters sometimes used for prompt-injection or
 * rendering tricks.
 * @param {string} value
 * @returns {string}
 */
function removeControlCharacters(value) {
  if (typeof value !== 'string') return value;

  // C0 controls except \t (0x09) and \n (0x0A); also strip DEL (0x7F).
  let cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Zero-width and bidi-control characters.
  cleaned = cleaned.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');

  return cleaned;
}

/**
 * Collapses excessive blank lines (3+) down to a single blank line so
 * padded/garbage input can't be used to inflate token usage cheaply.
 * @param {string} value
 * @returns {string}
 */
function collapseExcessiveBlankLines(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\n{3,}/g, '\n\n');
}

/**
 * Full sanitization pipeline. Use this as the single entry point from
 * feature code / aiService.js.
 * @param {string} value
 * @returns {string}
 */
function sanitize(value) {
  if (typeof value !== 'string') return value;

  let result = normalizeLineEndings(value);
  result = removeControlCharacters(result);
  result = collapseExcessiveBlankLines(result);
  result = trimWhitespace(result);

  return result;
}

/**
 * Recursively sanitizes every string value in a plain object/array payload.
 * Useful for sanitizing `options` blobs that may contain nested user text.
 * @param {*} payload
 * @returns {*}
 */
function sanitizeDeep(payload) {
  if (typeof payload === 'string') {
    return sanitize(payload);
  }

  if (Array.isArray(payload)) {
    return payload.map(sanitizeDeep);
  }

  if (payload && typeof payload === 'object') {
    const result = {};
    for (const key of Object.keys(payload)) {
      result[key] = sanitizeDeep(payload[key]);
    }
    return result;
  }

  return payload;
}

module.exports = {
  trimWhitespace,
  normalizeLineEndings,
  removeControlCharacters,
  collapseExcessiveBlankLines,
  sanitize,
  sanitizeDeep,
};
