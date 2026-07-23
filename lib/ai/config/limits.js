/**
 * AI feature limits — single shared source of truth.
 * ----------------------------------------------------
 * Every quota check for AI features (see the future AIUsage-backed
 * usage-tracking middleware) should read limits from here, never from a
 * hardcoded number in a model, controller, or route. Keeping the numbers
 * in one file means changing a plan's allowance is a one-line edit
 * instead of a hunt through the codebase.
 *
 * `AI_FEATURES` mirrors the feature modules already in src/ai/
 * (atsAnalyzer.js, coverLetterGenerator.js, interviewQuestions.js,
 * resumeGenerator.js, resumeParser.js, salaryEstimator.js) so the same
 * string key can be used consistently across AIUsage.feature,
 * AIHistory.feature, and SavedAIResult.feature.
 *
 * This file only defines configuration — it intentionally contains no
 * AI-provider logic, no route/controller code, and no persistence.
 */

/** Subscription plan identifiers — must match Subscription.plan. */
export const PLANS = Object.freeze({
  FREE: "free",
  PREMIUM: "premium",
});

/** Billing/usage period granularity a feature's limit resets on. */
export const PERIODS = Object.freeze({
  DAILY: "daily",
  MONTHLY: "monthly",
});

/** Sentinel used instead of a numeric cap to mean "no limit". */
export const UNLIMITED = -1;

/**
 * Feature keys — one entry per AI feature the app exposes (or will
 * expose). Add new features here first, then reference the same key
 * everywhere else (AIUsage, AIHistory, SavedAIResult, future routes).
 */
export const AI_FEATURES = Object.freeze({
  // Legacy keys mirroring the older src/ai/* modules — left untouched for
  // backward compatibility with anything still referencing them.
  ATS_ANALYZER: "atsAnalyzer",
  COVER_LETTER_GENERATOR: "coverLetterGenerator",
  INTERVIEW_QUESTIONS: "interviewQuestions",
  RESUME_GENERATOR: "resumeGenerator",
  RESUME_PARSER: "resumeParser",
  SALARY_ESTIMATOR: "salaryEstimator",

  // Phase 11 fix: the six shipped AI features (src/controllers/ai/*) each
  // check usage against their own FEATURE string (e.g. "resumeAnalyzer"),
  // but no entry existed here for any of them — every plan/feature lookup
  // silently fell through to UNLIMITED, so usage limits were never
  // actually enforced. Keys below match the FEATURE constants in
  // src/controllers/ai/*.controller.js and src/routes/ai/*.routes.js
  // exactly.
  RESUME_ANALYZER: "resumeAnalyzer",
  RESUME_REWRITE: "resumeRewrite",
  CAREER_COACH: "careerCoach",
  COVER_LETTER: "coverLetter",
  MOCK_INTERVIEW: "mockInterview",
  MATCH_SCORE: "matchScore",
});

/**
 * Per-feature, per-plan limits. `limit: UNLIMITED` means the plan has no
 * cap for that feature. `period` says how often `usageCount` resets
 * (interpreted by whatever future service owns AIUsage.currentPeriod).
 *
 * Numbers below are placeholder defaults, not final product decisions —
 * tune freely, this is the only place that needs to change.
 */
export const AI_FEATURE_LIMITS = Object.freeze({
  [AI_FEATURES.ATS_ANALYZER]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 3, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.COVER_LETTER_GENERATOR]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 3, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.INTERVIEW_QUESTIONS]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 5, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.RESUME_GENERATOR]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 2, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.RESUME_PARSER]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 5, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.SALARY_ESTIMATOR]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },

  // Phase 1 target: every shipped AI feature gets a consistent 10/month
  // free-tier allowance; premium stays unlimited.
  [AI_FEATURES.RESUME_ANALYZER]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.RESUME_REWRITE]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.CAREER_COACH]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.COVER_LETTER]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.MOCK_INTERVIEW]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
  [AI_FEATURES.MATCH_SCORE]: {
    period: PERIODS.MONTHLY,
    limits: { [PLANS.FREE]: 10, [PLANS.PREMIUM]: UNLIMITED },
  },
});

/**
 * Look up the numeric limit for a feature+plan pair.
 * Returns UNLIMITED for unknown plans/features rather than throwing —
 * callers can decide how to treat an unrecognized combination.
 *
 * @param {string} feature - one of AI_FEATURES values
 * @param {string} plan - one of PLANS values
 * @returns {number} the cap, or UNLIMITED (-1)
 */
export function getFeatureLimit(feature, plan) {
  const config = AI_FEATURE_LIMITS[feature];
  if (!config) return UNLIMITED;
  const limit = config.limits[plan];
  return typeof limit === "number" ? limit : UNLIMITED;
}

/**
 * The reset period (PERIODS.*) configured for a given feature.
 * Defaults to monthly if the feature isn't recognized.
 *
 * @param {string} feature - one of AI_FEATURES values
 * @returns {string}
 */
export function getFeaturePeriod(feature) {
  return AI_FEATURE_LIMITS[feature]?.period ?? PERIODS.MONTHLY;
}

/**
 * @param {number} limit - a value returned by getFeatureLimit()
 * @returns {boolean}
 */
export function isUnlimited(limit) {
  return limit === UNLIMITED;
}

export default {
  PLANS,
  PERIODS,
  UNLIMITED,
  AI_FEATURES,
  AI_FEATURE_LIMITS,
  getFeatureLimit,
  getFeaturePeriod,
  isUnlimited,
};
