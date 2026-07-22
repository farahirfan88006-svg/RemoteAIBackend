/**
 * historyService.js
 * ---------------------------------------------------------------------------
 * Reusable helpers for persisting and retrieving AI interaction history,
 * built on top of the existing AIHistory database model. Contains no
 * feature-specific logic — every AI feature calls the same three
 * functions: saveHistory, getHistory, deleteHistory.
 *
 * AIHistory model (src/models/AIHistory.js) shape actually used here:
 *   {
 *     userId: ObjectId (ref: User),
 *     feature: String,
 *     input: Mixed,      // { prompt, metadata } for this call
 *     output: Mixed,      // the text response returned to the user
 *     provider: String,   // optional, e.g. "free" / "demo-fallback"
 *     status: "pending" | "success" | "error",
 *     createdAt / updatedAt (timestamps),
 *   }
 *
 * FIX NOTE (stabilization pass): this file previously used CommonJS
 * require()/module.exports under an ESM ("type": "module") project, and
 * wrote documents using field names (user/prompt/response/metadata) that
 * don't exist on the real AIHistory schema (userId/input/output/status).
 * Both bugs meant every history save silently threw (caught by callers'
 * best-effort try/catch) and no AI interaction was ever actually recorded.
 * Converted to ESM and aligned to the real schema — the public function
 * signatures below are unchanged so no caller needed to change.
 * ---------------------------------------------------------------------------
 */

import AIHistory from '../../../src/models/AIHistory.js';

function getUserId(user) {
  if (!user) return null;
  return user._id || user.id || user.userId || null;
}

/**
 * Persists a single AI interaction. Designed to be "best effort": failures
 * here should never block the actual AI response from reaching the user,
 * so callers may choose to await it without letting a rejection propagate.
 *
 * @param {Object} params
 * @param {Object} params.user - Authenticated user object (from middleware).
 * @param {string} params.feature - Feature key, e.g. "resumeAnalyzer".
 * @param {string} params.prompt - Sanitized prompt/input that was sent.
 * @param {string} params.response - Text response returned to the user.
 * @param {string} [params.provider] - Internal provider name (not exposed to frontend).
 * @param {Object} [params.metadata] - Any extra feature-specific metadata.
 * @param {string} [params.status='success'] - Request lifecycle status.
 * @returns {Promise<Object|null>} The created history document, or null if skipped.
 */
export async function saveHistory({
  user,
  feature,
  prompt,
  response,
  provider,
  metadata,
  status = 'success',
} = {}) {
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
    input: { prompt: prompt || '', metadata: metadata || undefined },
    output: response || '',
    provider: provider || '',
    status,
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
