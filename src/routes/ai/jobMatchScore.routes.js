/**
 * src/routes/ai/jobMatchScore.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/job-match-score in app.js.
 *
 * Accepts resume text, a job description, skills, experience, and education
 * as JSON. The match score itself is always computed by a deterministic,
 * rule-based algorithm in the controller (never by the AI provider); the
 * shared lib/ai architecture (aiService/historyService/usage middleware) is
 * used only to optionally enhance the result with an explanation,
 * improvement suggestions, and career advice, with a graceful local
 * fallback when the active provider is unavailable — same pattern as
 * resumeAnalyzer.routes.js, resumeRewrite.routes.js, careerCoach.routes.js,
 * coverLetterAI.routes.js, and mockInterview.routes.js.
 *
 * Middleware order matters:
 *   requireAuth              -> attaches req.user
 *   checkUsageLimit()        -> attaches req.usage, blocks with 429 if exhausted
 *   calculateJobMatchScore   -> does the work, responds, calls next() only on success
 *   incrementUsage()         -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { calculateJobMatchScore } from "../../controllers/ai/jobMatchScore.controller.js";

const FEATURE = "matchScore";

const router = Router();

router.post(
  "/calculate",
  requireAuth,
  checkUsageLimit(FEATURE),
  calculateJobMatchScore,
  incrementUsage(FEATURE),
);

export default router;
