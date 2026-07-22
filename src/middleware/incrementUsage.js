/**
 * src/middleware/incrementUsage.js
 * ---------------------------------------------------------------------------
 * Middleware factory: incrementUsage(feature, amount = 1) -> (req, res, next)
 *
 * Must run AFTER requireAuth (expects `req.user`). Typically placed AFTER
 * checkUsageLimit and (once built) the actual AI call, so usage is only
 * recorded for requests that were allowed through / actually consumed the
 * resource. It can also be used standalone wherever a usage increment is
 * needed.
 *
 * - Increases the usage count for the given feature via
 *   lib/ai/usage/usageService.js.
 * - Creates the AIUsage document automatically if it doesn't exist yet.
 * - Automatically resets the count when the stored `currentPeriod` has
 *   rolled over to a new month before applying the increment.
 *
 * Usage:
 *   router.post(
 *     '/ai/chat',
 *     requireAuth,
 *     checkUsageLimit('chatMessages'),
 *     aiChatController,        // not implemented in this task
 *     incrementUsage('chatMessages')
 *   );
 * ---------------------------------------------------------------------------
 */

import { incrementUsage as incrementUsageService } from '../../lib/ai/usage/usageService.js';

export default function incrementUsage(feature, amount = 1) {
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
          message: 'incrementUsage middleware is misconfigured: no feature name was provided.',
          plan: null,
          usageRemaining: null,
          data: null,
          errors: ['MISSING_FEATURE_NAME'],
        });
      }

      const usage = await incrementUsageService(req.user._id, feature, amount);

      req.usage = {
        ...(req.usage || {}),
        feature,
        used: usage.count,
        currentPeriod: usage.currentPeriod,
      };

      return next();
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Something went wrong while recording usage.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: [err.message || 'USAGE_INCREMENT_ERROR'],
      });
    }
  };
}
