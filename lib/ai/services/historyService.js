/**
 * historyService.js
 * ---------------------------------------------------------------------------
 * Reusable helpers for persisting and retrieving AI interaction history,
 * built on top of the existing AIHistory database model. Contains no
 * feature-specific logic — every future AI feature calls the same three
 * functions: saveHistory, getHistory, deleteHistory.
 *
 * ASSUMED CONTRACT (already implemented elsewhere in this repo):
 *   An AIHistory Mongoose model with roughly this shape:
 *     {
 *       user: ObjectId (ref: User),
 *       feature: String,
 *       prompt: String,
 *       response: String,
 *       provider: String,       // optional
 *       metadata: Object,       // optional
 *       createdAt: Date,
 *     }
 *
 * INTEGRATION NOTE:
 * If your AIHistory model lives at a different path than the candidates
 * below, add it to CANDIDATE_MODEL_PATHS (first match wins). Nothing else
 * in lib/ai needs to change.
 */

'use strict';

const CANDIDATE_MODEL_PATHS = [
  '../../../src/models/AIHistory',
  '../../../src/models/aiHistory',
  '../../../src/models/aiHistoryModel',
  '../../../src/models/AiHistory',
  '../../../src/models/ai/AIHistory',
];

let cachedModel = null;
let cachedModelError = null;

function loadAIHistoryModel() {
  if (cachedModel || cachedModelError) {
    return cachedModel;
  }

  for (const candidate of CANDIDATE_MODEL_PATHS) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(candidate);
      cachedModel = mod && mod.default ? mod.default : mod;
      return cachedModel;
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') {
        cachedModelError = err;
        throw err;
      }
    }
  }

  cachedModelError = new Error(
    '[historyService] Could not locate the existing AIHistory model. ' +
      'Update CANDIDATE_MODEL_PATHS in lib/ai/services/historyService.js ' +
      'to point at your AIHistory model file.'
  );
  throw cachedModelError;
}

function getUserId(user) {
  if (!user) return null;
  return user._id || user.id || user.userId || null;
}

/**
 * Persists a single AI interaction. Designed to be "best effort": failures
 * here should never block the actual AI response from reaching the user,
 * so callers may choose to await it without letting a rejection propagate
 * (aiService.js does this).
 *
 * @param {Object} params
 * @param {Object} params.user - Authenticated user object (from middleware).
 * @param {string} params.feature - Feature key, e.g. "resume-analyzer".
 * @param {string} params.prompt - Sanitized prompt/input that was sent.
 * @param {string} params.response - Text response returned to the user.
 * @param {string} [params.provider] - Internal provider name (not exposed to frontend).
 * @param {Object} [params.metadata] - Any extra feature-specific metadata.
 * @returns {Promise<Object|null>} The created history document, or null if skipped.
 */
async function saveHistory({ user, feature, prompt, response, provider, metadata } = {}) {
  const AIHistory = loadAIHistoryModel();
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot save history without a valid user id.');
  }
  if (!feature) {
    throw new Error('[historyService] Cannot save history without a feature key.');
  }

  const doc = await AIHistory.create({
    user: userId,
    feature,
    prompt: prompt || '',
    response: response || '',
    provider: provider || undefined,
    metadata: metadata || undefined,
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
async function getHistory({ user, feature, limit = 20, page = 1 } = {}) {
  const AIHistory = loadAIHistoryModel();
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot fetch history without a valid user id.');
  }

  const query = { user: userId };
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
async function deleteHistory({ user, historyId } = {}) {
  const AIHistory = loadAIHistoryModel();
  const userId = getUserId(user);

  if (!userId) {
    throw new Error('[historyService] Cannot delete history without a valid user id.');
  }
  if (!historyId) {
    throw new Error('[historyService] historyId is required to delete a history entry.');
  }

  const result = await AIHistory.deleteOne({ _id: historyId, user: userId });
  return Boolean(result && result.deletedCount > 0);
}

module.exports = {
  saveHistory,
  getHistory,
  deleteHistory,
};
