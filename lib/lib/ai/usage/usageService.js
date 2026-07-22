/**
 * lib/ai/usage/usageService.js
 * ---------------------------------------------------------------------------
 * Reusable, framework-agnostic helpers for reading and mutating AI usage.
 * These are consumed by src/middleware/checkUsageLimit.js and
 * src/middleware/incrementUsage.js, and can also be called directly from
 * AI controllers/routes.
 *
 * AIUsage model (src/models/AIUsage.js) fields actually used here:
 *     userId         ObjectId  (ref to User)
 *     feature        String
 *     usageCount     Number    (default 0)
 *     currentPeriod  String    (e.g. "2026-07", the billing/calendar month)
 *
 * Limits are read from `lib/ai/config/limits.js`'s real exported API
 * (getFeatureLimit(feature, plan) / isUnlimited(limit)) — see that file
 * for the single source of truth on per-plan, per-feature caps.
 *
 * FIX NOTE (stabilization pass): this file previously wrote/read AIUsage
 * documents using field names (`user`, `count`) that don't exist on the
 * real AIUsage schema (`userId`, `usageCount`), and looked up limits via
 * a defensive shape-guessing helper that didn't match limits.js's actual
 * exports (getFeatureLimit/isUnlimited). Together these meant every usage
 * check/increment either failed schema validation or silently reported
 * "unlimited" for every plan and feature. Aligned to the real schema and
 * the real limits.js API — public function signatures are unchanged.
 * ---------------------------------------------------------------------------
 */

import AIUsage from '../../../src/models/AIUsage.js';
import limits, { getFeatureLimit, isUnlimited as isUnlimitedLimit } from '../config/limits.js';

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
 * lib/ai/config/limits.js without hardcoding any numbers here.
 * Returns `null` if the feature is unlimited / not configured.
 */
function getLimitForPlan(plan, feature) {
  const getLimit = (limits && limits.getFeatureLimit) || getFeatureLimit;
  const unlimitedCheck = (limits && limits.isUnlimited) || isUnlimitedLimit;

  if (typeof getLimit !== 'function') return null;

  const resolved = getLimit(feature, plan);
  if (typeof unlimitedCheck === 'function' && unlimitedCheck(resolved)) {
    return null;
  }
  return typeof resolved === 'number' ? resolved : null;
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
 */
export async function getRemainingUsage(userId, feature, plan = 'free') {
  const usage = await resetUsageIfNeeded(userId, feature);
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
    usage = await AIUsage.create({ userId, feature, usageCount: amount, currentPeriod, lastUsedAt: new Date() });
    return usage;
  }

  if (usage.currentPeriod !== currentPeriod) {
    usage.usageCount = amount;
    usage.currentPeriod = currentPeriod;
  } else {
    usage.usageCount += amount;
  }
  usage.lastUsedAt = new Date();

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
  getCurrentPeriod,
  getUsage,
  resetUsageIfNeeded,
  getRemainingUsage,
  incrementUsage,
  formatUsageResponse,
};
