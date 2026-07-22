/**
 * src/routes/ai/coverLetterAI.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/cover-letter in app.js.
 *
 * Distinct from the existing /api/cover-letters routes (coverLetters.routes.js
 * / coverLetters.controller.js), which are plain CRUD for saved cover letter
 * records. This route accepts company/job/applicant/resume details as JSON
 * and goes through the shared lib/ai architecture (aiService/historyService/
 * usage middleware), with a graceful local fallback when the active provider
 * is unavailable — same pattern as resumeAnalyzer.routes.js,
 * resumeRewrite.routes.js, and careerCoach.routes.js.
 *
 * Middleware order matters:
 *   requireAuth             -> attaches req.user
 *   checkUsageLimit()       -> attaches req.usage, blocks with 429 if exhausted
 *   generateCoverLetterAI   -> does the work, responds, calls next() only on success
 *   incrementUsage()        -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { generateCoverLetterAI } from "../../controllers/ai/coverLetterAI.controller.js";

const FEATURE = "coverLetter";

const router = Router();

router.post(
  "/generate",
  requireAuth,
  checkUsageLimit(FEATURE),
  generateCoverLetterAI,
  incrementUsage(FEATURE),
);

export default router;
