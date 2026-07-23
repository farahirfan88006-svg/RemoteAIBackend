/**
 * historyService.js
 * ---------------------------------------------------------------------------
 * Reusable helpers for persisting and retrieving AI interaction history,
 * built on top of the existing AIHistory database model. Contains no
 * feature-specific logic — every AI feature calls the same three
 * functions: saveHistory, getHistory, deleteHistory.
 *
 * Phase 11 stabilization fix (two bugs, same root cause):
 *   1. This file previously used CommonJS require()/module.exports inside
 *      an ESM ("type": "module") project, which threw a ReferenceError the
 *      instant it was loaded. Every controller's dynamic `await import(...)`
 *      swallowed that error, so history was silently never saved.
 *   2. It also built AIHistory.create() documents with field names
 *      (`user`, `prompt`, `response`, `metadata`) that don't match the real
 *      schema in src/models/AIHistory.js (`userId`, `input`, `output`,
 *      `status`) — a required-field validation error on every attempt, even
 *      once (1) was fixed.
 * Both are fixed here. The public function signatures are unchanged so no
 * caller (aiService.js, every AI controller) needs to change.
 */

import AIHistory from '../../../src/models/AIHistory.js';

function getUserId(user) {
  if (!user) return null;
  return user._id || user.id || user.userId || null;
}

/**
 * Persists a single AI interaction. Designed to be "best effort": failures
 * here should never block the actual AI response from reaching the user,
 * so callers may choose to await it without letting a rejection propagate
 * (aiService.js and every AI controller do this).
 *
 * @param {Object} params
 * @param {Object} params.user - Authenticated user object (from middleware).
 * @param {string} params.feature - Feature key, e.g. "resumeAnalyzer".
 * @param {string} params.prompt - Sanitized prompt/input that was sent (stored as `input`).
 * @param {string} params.response - Text response returned to the user (stored as `output`).
 * @param {string} [params.provider] - Internal provider name (not exposed to frontend).
 * @param {string} [params.status] - AIHistory.status ("pending" | "success" | "error"); defaults to "success".
 * @param {Object} [params.metadata] - Accepted for API compatibility; the AIHistory schema has no
 *   dedicated metadata field, so this is not persisted (kept as a no-op parameter, not silently dropped mid-pipeline).
 * @returns {Promise<Object>} The created history document.
 */
export async function saveHistory({ user, feature, prompt, response, provider, status, metadata } = {}) {
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot save history without a valid user id.');
  }
  if (!feature) {
    throw new Error('[historyService] Cannot save history without a feature key.');
  }

  const doc = await AIHistory.create({
    userId,
    feature,
    input: prompt ?? null,
    output: response ?? null,
    provider: provider || '',
    status: status || 'success',
  });

  return doc;
}

/**
 * Retrieves AI interaction history for a user, optionally scoped to a
 * specific feature, with basic pagination.
 *
 * @param {Object} params
 * @param {Object} params.user
 * @param {string} [params.feature] - If omitted, returns history across all features.
 * @param {number} [params.limit=20]
 * @param {number} [params.page=1]
 * @returns {Promise<{ items: Object[], total: number, page: number, limit: number }>}
 */
export async function getHistory({ user, feature, limit = 20, page = 1 } = {}) {
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot fetch history without a valid user id.');
  }

  const query = { userId };
  if (feature) query.feature = feature;

  const safeLimit = Math.max(1, Math.min(limit || 20, 100));
  const safePage = Math.max(1, page || 1);
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    AIHistory.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    AIHistory.countDocuments(query),
  ]);

  return { items, total, page: safePage, limit: safeLimit };
}

/**
 * Deletes a single history entry, scoped to the owning user so one user
 * can never delete another user's history record.
 *
 * @param {Object} params
 * @param {Object} params.user
 * @param {string} params.historyId
 * @returns {Promise<boolean>} true if a document was deleted.
 */
export async function deleteHistory({ user, historyId } = {}) {
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot delete history without a valid user id.');
  }
  if (!historyId) {
    throw new Error('[historyService] historyId is required to delete a history entry.');
  }

  const result = await AIHistory.deleteOne({ _id: historyId, userId });
  return Boolean(result && result.deletedCount > 0);
}

export default {
  saveHistory,
  getHistory,
  deleteHistory,
};
