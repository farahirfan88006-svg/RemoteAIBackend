/**
 * lib/ai/usage/usageService.js
 * ---------------------------------------------------------------------------
 * Reusable, framework-agnostic helpers for reading and mutating AI usage.
 * These are consumed by src/middleware/checkUsageLimit.js and
 * src/middleware/incrementUsage.js, and can also be called directly from
 * future AI controllers/routes.
 *
 * STABILIZATION FIX (this pass):
 *  1. Field-name mismatch bug (root cause of the 500s on
 *     POST /api/ai/career-coach/advice and POST /api/ai/mock-interview/start,
 *     and every other /api/ai/* route that uses checkUsageLimit /
 *     incrementUsage):
 *
 *     This file previously read/wrote AIUsage documents using `user` and
 *     `count` as field names. The real schema in `src/models/AIUsage.js`
 *     defines them as `userId` (required) and `usageCount` (required).
 *     Because `findOne({ user: userId, feature })` never matched anything
 *     (wrong field name), every request fell through to
 *     `AIUsage.create({ user, feature, count: 0, currentPeriod })`, which
 *     omits the two required fields (`userId`, `usageCount`) and throws a
 *     Mongoose ValidationError on every single call. That error propagated
 *     out of checkUsageLimit's try/catch as an uncaught-by-design 500,
 *     before the career-coach/mock-interview controllers ever ran.
 *     Fixed by using the real field names (`userId`, `usageCount`)
 *     everywhere in this file — confirmed against the schema and against
 *     `src/middleware/incrementUsage.js`, which already correctly reads
 *     `usage.usageCount`.
 *
 *  2. `getLimitForPlan()` was written defensively to guess at the shape of
 *     `lib/ai/config/limits.js`, but the real file exports
 *     `getFeatureLimit(feature, plan)` and nests limits under
 *     `AI_FEATURE_LIMITS[feature].limits[plan]` — none of the guessed
 *     shapes matched, so every lookup silently fell through to "unlimited".
 *     Fixed to call the real `getFeatureLimit`/`isUnlimited` exports
 *     directly.
 *
 *  3. TEMPORARY: all AI features are unmetered/free for everyone while the
 *     product is in testing (no payments yet — see TEMP_FREE_ACCESS below).
 *     This is layered on top of the real limit lookup (not a replacement
 *     for it) so removing the flag later restores real plan-based limits
 *     with no further code changes needed.
 * ---------------------------------------------------------------------------
 */

import AIUsage from '../../../src/models/AIUsage.js';
import { getFeatureLimit, isUnlimited } from '../config/limits.js';

/**
 * Controls whether free-tier usage limits are actually enforced.
 *
 * Usage is always recorded (AIUsage documents are always created/
 * incremented normally below) regardless of this flag — it only disables
 * the *blocking* behavior, not the tracking.
 *
 * Defaults to `false` (limits enforced) now that free-tier caps are live.
 * Can still be disabled instantly without a code change/deploy — e.g. if
 * billing needs to be paused — by setting AI_TEMP_FREE_ACCESS=true in the
 * environment.
 */
export const TEMP_FREE_ACCESS = String(process.env.AI_TEMP_FREE_ACCESS || '').toLowerCase() === 'true';

/**
 * Returns the current billing/calendar period key, e.g. "2026-07".
 * Centralized here so every helper resets on the same boundary.
 */
export function getCurrentPeriod(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Resolves the configured limit for a given plan + feature from
 * lib/ai/config/limits.js. Returns `null` if the feature/plan combination
 * has no cap (unlimited).
 */
function getLimitForPlan(plan, feature) {
  const limit = getFeatureLimit(feature, plan);
  return isUnlimited(limit) ? null : limit;
}

/**
 * Fetches the raw usage document for a user/feature. Does NOT persist a
 * period reset — use resetUsageIfNeeded() for that. Useful for read-only
 * reporting where you don't want a write on every read.
 */
export async function getUsage(userId, feature) {
  const currentPeriod = getCurrentPeriod();
  const usage = await AIUsage.findOne({ userId, feature });

  if (!usage) {
    return { userId, feature, usageCount: 0, currentPeriod, isNew: true };
  }

  if (usage.currentPeriod !== currentPeriod) {
    // Stale period — report as reset without writing to the DB.
    return {
      userId,
      feature,
      usageCount: 0,
      currentPeriod,
      isNew: false,
      isStale: true,
    };
  }

  return usage;
}

/**
 * Ensures a usage document exists and is on the current period,
 * persisting a reset (usageCount -> 0, currentPeriod -> now) when the
 * stored period has rolled over. Creates the document if missing.
 */
export async function resetUsageIfNeeded(userId, feature) {
  const currentPeriod = getCurrentPeriod();
  let usage = await AIUsage.findOne({ userId, feature });

  if (!usage) {
    usage = await AIUsage.create({ userId, feature, usageCount: 0, currentPeriod });
    return usage;
  }

  if (usage.currentPeriod !== currentPeriod) {
    usage.usageCount = 0;
    usage.currentPeriod = currentPeriod;
    await usage.save();
  }

  return usage;
}

/**
 * Computes remaining usage for a user/feature/plan.
 * Returns { limit, used, remaining, unlimited }.
 * `limit`/`remaining` are `null` when the feature has no configured cap.
 *
 * TEMP_FREE_ACCESS short-circuits this to always report unlimited (see the
 * flag's doc comment above) while still ensuring the usage document exists
 * and is on the current period, so real numbers are already being tracked
 * underneath.
 */
export async function getRemainingUsage(userId, feature, plan = 'free') {
  const usage = await resetUsageIfNeeded(userId, feature);

  if (TEMP_FREE_ACCESS) {
    return { limit: null, used: usage.usageCount, remaining: null, unlimited: true };
  }

  const limit = getLimitForPlan(plan, feature);

  if (limit === null || limit === undefined) {
    return { limit: null, used: usage.usageCount, remaining: null, unlimited: true };
  }

  const remaining = Math.max(limit - usage.usageCount, 0);
  return { limit, used: usage.usageCount, remaining, unlimited: false };
}

/**
 * Increments usage by `amount` (default 1), creating the usage document
 * automatically if it doesn't exist, and resetting the count first if the
 * stored period has rolled over. Returns the updated usage document.
 */
export async function incrementUsage(userId, feature, amount = 1) {
  const currentPeriod = getCurrentPeriod();
  let usage = await AIUsage.findOne({ userId, feature });

  if (!usage) {
    usage = await AIUsage.create({ userId, feature, usageCount: amount, currentPeriod });
    return usage;
  }

  if (usage.currentPeriod !== currentPeriod) {
    usage.usageCount = amount;
    usage.currentPeriod = currentPeriod;
  } else {
    usage.usageCount += amount;
  }

  await usage.save();
  return usage;
}

/**
 * Small helper to keep the { success, message, plan, usageRemaining,
 * data, errors } response shape consistent across every middleware that
 * uses this service. Purely a convenience — middlewares may also build
 * the object inline.
 */
export function formatUsageResponse({
  success,
  message,
  plan = null,
  usageRemaining = null,
  data = null,
  errors = [],
}) {
  return { success, message, plan, usageRemaining, data, errors };
}

export default {
  TEMP_FREE_ACCESS,
  getCurrentPeriod,
  getUsage,
  resetUsageIfNeeded,
  getRemainingUsage,
  incrementUsage,
  formatUsageResponse,
};
