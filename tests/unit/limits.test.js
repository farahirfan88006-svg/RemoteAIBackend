import { test } from 'node:test';
import assert from 'node:assert/strict';
import limits, { AI_FEATURES, getFeatureLimit, isUnlimited, PLANS } from '../../lib/ai/config/limits.js';

const COMPLETED_FEATURES = [
  AI_FEATURES.RESUME_ANALYZER,
  AI_FEATURES.RESUME_REWRITE,
  AI_FEATURES.CAREER_COACH,
  AI_FEATURES.COVER_LETTER,
  AI_FEATURES.MOCK_INTERVIEW,
  AI_FEATURES.MATCH_SCORE,
];

test('every completed AI feature has a configured free-plan limit', () => {
  for (const feature of COMPLETED_FEATURES) {
    const limit = getFeatureLimit(feature, PLANS.FREE);
    assert.ok(
      typeof limit === 'number' && limit > 0,
      `expected a positive numeric free-plan limit for "${feature}", got ${limit}`,
    );
  }
});

test('every completed AI feature is unlimited on the premium plan', () => {
  for (const feature of COMPLETED_FEATURES) {
    const limit = getFeatureLimit(feature, PLANS.PREMIUM);
    assert.equal(isUnlimited(limit), true, `expected "${feature}" to be unlimited on premium`);
  }
});

test('feature keys match the FEATURE constants used by routes/controllers', () => {
  // These string values MUST match src/routes/ai/*.routes.js and
  // src/controllers/ai/*.controller.js FEATURE constants exactly, since
  // usageService.js looks limits up by this string.
  assert.equal(AI_FEATURES.RESUME_ANALYZER, 'resumeAnalyzer');
  assert.equal(AI_FEATURES.RESUME_REWRITE, 'resumeRewrite');
  assert.equal(AI_FEATURES.CAREER_COACH, 'careerCoach');
  assert.equal(AI_FEATURES.COVER_LETTER, 'coverLetter');
  assert.equal(AI_FEATURES.MOCK_INTERVIEW, 'mockInterview');
  assert.equal(AI_FEATURES.MATCH_SCORE, 'matchScore');
});

test('default export exposes the same helpers as named exports', () => {
  assert.equal(typeof limits.getFeatureLimit, 'function');
  assert.equal(typeof limits.isUnlimited, 'function');
});
