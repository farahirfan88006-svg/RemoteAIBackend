/**
 * src/middleware/checkUsageLimit.js
 * ---------------------------------------------------------------------------
 * Middleware factory: checkUsageLimit(feature) -> (req, res, next)
 *
 * Must run AFTER requireAuth (expects `req.user`). If requirePremium ran
 * first, `req.userPlan` is reused; otherwise plan defaults to 'free'.
 *
 * - Reads current usage via lib/ai/usage/usageService.js (backed by the
 *   existing AIUsage model).
 * - Reads limits via lib/ai/config/limits.js (through usageService — never
 *   hardcoded here).
 * - Rejects with 429 when the limit has been reached.
 * - On success, attaches `req.usage = { feature, plan, limit, used,
 *   remaining, unlimited }` for downstream handlers/middleware to use.
 *
 * Usage:
 *   router.post('/ai/chat', requireAuth, checkUsageLimit('chatMessages'), handler);
 * ---------------------------------------------------------------------------
 */

import Subscription from '../models/Subscription.js';
import { getRemainingUsage } from '../../lib/ai/usage/usageService.js';

/**
 * Resolves the user's real plan for usage-limiting purposes.
 *
 * FIX NOTE (stabilization pass): none of the six AI routes wire up
 * requirePremium.js (which is the only other place that ever set
 * `req.userPlan`), so this middleware previously always fell through to
 * `req.userPlan || 'free'` — meaning even active Premium subscribers were
 * checked against the free plan's limits. This mirrors requirePremium's
 * own Subscription lookup (without blocking the request) so plan-aware
 * limiting actually works regardless of which middleware ran earlier.
 */
async function resolvePlan(req) {
  if (req.userPlan) return req.userPlan;

  const subscription = await Subscription.findOne({ userId: req.user._id });
  const plan = subscription?.plan || 'free';
  const isActive = subscription?.status ? subscription.status === 'active' : false;
  return plan === 'premium' && isActive ? 'premium' : 'free';
}

export default function checkUsageLimit(feature) {
  return async function (req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required.',
          plan: null,
          usageRemaining: null,
          data: null,
          errors: ['NOT_AUTHENTICATED'],
        });
      }

      if (!feature) {
        return res.status(500).json({
          success: false,
          message: 'checkUsageLimit middleware is misconfigured: no feature name was provided.',
          plan: null,
          usageRemaining: null,
          data: null,
          errors: ['MISSING_FEATURE_NAME'],
        });
      }

      const plan = await resolvePlan(req);
      req.userPlan = plan;
      const { limit, used, remaining, unlimited } = await getRemainingUsage(
        req.user._id,
        feature,
        plan
      );

      if (!unlimited && remaining <= 0) {
        return res.status(429).json({
          success: false,
          message: `You have reached your ${feature} usage limit for this billing period.`,
          plan,
          usageRemaining: 0,
          data: { feature, limit, used },
          errors: ['USAGE_LIMIT_EXCEEDED'],
        });
      }

      req.usage = { feature, plan, limit, used, remaining, unlimited };
      return next();
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Something went wrong while checking usage limits.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: [err.message || 'USAGE_CHECK_ERROR'],
      });
    }
  };
}
