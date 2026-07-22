/**
 * src/routes/ai/careerCoach.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/career-coach in app.js.
 *
 * Accepts a career goal, current skills, experience, and a target role as
 * JSON and goes through the shared lib/ai architecture (aiService /
 * historyService / usage middleware), with a graceful local fallback when
 * the active provider is unavailable — same pattern as
 * resumeAnalyzer.routes.js and resumeRewrite.routes.js.
 *
 * Middleware order matters:
 *   requireAuth        -> attaches req.user
 *   checkUsageLimit()  -> attaches req.usage, blocks with 429 if exhausted
 *   getCareerAdvice    -> does the work, responds, calls next() only on success
 *   incrementUsage()   -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { getCareerAdvice } from "../../controllers/ai/careerCoach.controller.js";

const FEATURE = "careerCoach";

const router = Router();

router.post(
  "/advice",
  requireAuth,
  checkUsageLimit(FEATURE),
  getCareerAdvice,
  incrementUsage(FEATURE),
);

export default router;
