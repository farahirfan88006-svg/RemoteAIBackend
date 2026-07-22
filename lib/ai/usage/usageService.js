/**
 * lib/ai/usage/usageService.js
 * ---------------------------------------------------------------------------
 * Reusable, framework-agnostic helpers for reading and mutating AI usage.
 * These are consumed by src/middleware/checkUsageLimit.js and
 * src/middleware/incrementUsage.js, and can also be called directly from
 * future AI controllers/routes.
 *
 * ASSUMPTIONS (this file only READS these — nothing here modifies them):
 *  - An `AIUsage` Mongoose model already exists at `src/models/AIUsage.js`
 *    (default export) with (at minimum) the fields:
 *        user           ObjectId  (ref to User)
 *        feature        String    (e.g. "chatMessages", "imageGenerations")
 *        count          Number    (default 0)
 *        currentPeriod  String    (e.g. "2026-07", the billing/calendar month)
 *    If your schema uses different field names, adjust the object literals
 *    below (search for `user:`, `feature:`, `count:`, `currentPeriod:`).
 *
 *  - `lib/ai/config/limits.js` already exists and exports the per-plan,
 *    per-feature limits. `getLimitForPlan()` below is written defensively to
 *    support a few common shapes so this integrates without needing to know
 *    the exact export shape in advance:
 *        export default { free: { chatMessages: 20 }, premium: { chatMessages: 1000 } }
 *        export default { chatMessages: { free: 20, premium: 1000 } }
 *        export function getLimit(plan, feature) { ... }
 *    If none of these match your real file, only `getLimitForPlan()` needs
 *    a one-line tweak — nothing else in this module needs to change.
 * ---------------------------------------------------------------------------
 */

import AIUsage from '../../../src/models/AIUsage.js';
import limits from '../config/limits.js';

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
  if (!limits) return null;

  if (typeof limits.getLimit === 'function') {
    const resolved = limits.getLimit(plan, feature);
    return resolved === undefined ? null : resolved;
  }

  if (limits[plan] && Object.prototype.hasOwnProperty.call(limits[plan], feature)) {
    return limits[plan][feature];
  }

  if (Object.prototype.hasOwnProperty.call(limits, feature)) {
    const featureLimits = limits[feature];
    if (featureLimits && typeof featureLimits === 'object') {
      return Object.prototype.hasOwnProperty.call(featureLimits, plan)
        ? featureLimits[plan]
        : null;
    }
    return featureLimits ?? null;
  }

  return null;
}

/**
 * Fetches the raw usage document for a user/feature. Does NOT persist a
 * period reset — use resetUsageIfNeeded() for that. Useful for read-only
 * reporting where you don't want a write on every read.
 */
export async function getUsage(userId, feature) {
  const currentPeriod = getCurrentPeriod();
  const usage = await AIUsage.findOne({ user: userId, feature });

  if (!usage) {
    return { user: userId, feature, count: 0, currentPeriod, isNew: true };
  }

  if (usage.currentPeriod !== currentPeriod) {
    // Stale period — report as reset without writing to the DB.
    return {
      user: userId,
      feature,
      count: 0,
      currentPeriod,
      isNew: false,
      isStale: true,
    };
  }

  return usage;
}

/**
 * Ensures a usage document exists and is on the current period,
 * persisting a reset (count -> 0, currentPeriod -> now) when the
 * stored period has rolled over. Creates the document if missing.
 */
export async function resetUsageIfNeeded(userId, feature) {
  const currentPeriod = getCurrentPeriod();
  let usage = await AIUsage.findOne({ user: userId, feature });

  if (!usage) {
    usage = await AIUsage.create({ user: userId, feature, count: 0, currentPeriod });
    return usage;
  }

  if (usage.currentPeriod !== currentPeriod) {
    usage.count = 0;
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
    return { limit: null, used: usage.count, remaining: null, unlimited: true };
  }

  const remaining = Math.max(limit - usage.count, 0);
  return { limit, used: usage.count, remaining, unlimited: false };
}

/**
 * Increments usage by `amount` (default 1), creating the usage document
 * automatically if it doesn't exist, and resetting the count first if the
 * stored period has rolled over. Returns the updated usage document.
 */
export async function incrementUsage(userId, feature, amount = 1) {
  const currentPeriod = getCurrentPeriod();
  let usage = await AIUsage.findOne({ user: userId, feature });

  if (!usage) {
    usage = await AIUsage.create({ user: userId, feature, count: amount, currentPeriod });
    return usage;
  }

  if (usage.currentPeriod !== currentPeriod) {
    usage.count = amount;
    usage.currentPeriod = currentPeriod;
  } else {
    usage.count += amount;
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
  getCurrentPeriod,
  getUsage,
  resetUsageIfNeeded,
  getRemainingUsage,
  incrementUsage,
  formatUsageResponse,
};
