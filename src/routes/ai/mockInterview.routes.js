/**
 * src/routes/ai/mockInterview.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/mock-interview in app.js.
 *
 * Accepts a job title, experience level, interview type (technical/hr/
 * behavioral), skills, and resume text as JSON and goes through the shared
 * lib/ai architecture (aiService/historyService/usage middleware), with a
 * graceful local fallback when the active provider is unavailable — same
 * pattern as resumeAnalyzer.routes.js, resumeRewrite.routes.js,
 * careerCoach.routes.js, and coverLetterAI.routes.js.
 *
 * Middleware order matters:
 *   requireAuth          -> attaches req.user
 *   checkUsageLimit()    -> attaches req.usage, blocks with 429 if exhausted
 *   startMockInterview   -> does the work, responds, calls next() only on success
 *   incrementUsage()     -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { startMockInterview } from "../../controllers/ai/mockInterview.controller.js";

const FEATURE = "mockInterview";

const router = Router();

router.post(
  "/start",
  requireAuth,
  checkUsageLimit(FEATURE),
  startMockInterview,
  incrementUsage(FEATURE),
);

export default router;
