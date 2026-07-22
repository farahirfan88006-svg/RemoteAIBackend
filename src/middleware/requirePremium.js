/**
 * src/middleware/requirePremium.js
 * ---------------------------------------------------------------------------
 * Must run AFTER requireAuth (expects `req.user` to already be set).
 * Reads the user's Subscription document and allows the request through
 * only if they are on an active Premium plan. Free users get a consistent
 * "upgrade required" JSON response instead of a hard error.
 *
 * ASSUMPTIONS (adjust the marked lines if your Subscription schema differs):
 *  - `src/models/Subscription.js` exports a Mongoose model as its default
 *    export.
 *  - Schema has (at minimum): { user: ObjectId, plan: 'free' | 'premium',
 *    status: 'active' | 'canceled' | ... }.
 *  - Users with no Subscription document are treated as 'free'.
 * ---------------------------------------------------------------------------
 */

import Subscription from '../models/Subscription.js';

export default async function requirePremium(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required before checking subscription status.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: ['NOT_AUTHENTICATED'],
      });
    }

    const subscription = await Subscription.findOne({ user: req.user._id });
    const plan = subscription?.plan || 'free';
    const isActive = subscription?.status ? subscription.status === 'active' : false;
    const isPremium = plan === 'premium' && isActive;

    if (!isPremium) {
      return res.status(403).json({
        success: false,
        message: 'This feature is only available on the Premium plan. Upgrade to unlock it.',
        plan,
        usageRemaining: null,
        data: { upgradeRequired: true, upgradeUrl: '/billing/upgrade' },
        errors: ['PREMIUM_REQUIRED'],
      });
    }

    // Made available to downstream middleware (e.g. checkUsageLimit)
    // so the plan doesn't need to be re-fetched from the DB again.
    req.subscription = subscription;
    req.userPlan = plan;

    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while checking your subscription.',
      plan: null,
      usageRemaining: null,
      data: null,
      errors: [err.message || 'SUBSCRIPTION_CHECK_ERROR'],
    });
  }
}
