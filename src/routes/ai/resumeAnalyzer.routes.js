/**
 * src/routes/ai/resumeAnalyzer.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/resume-analyzer in app.js.
 *
 * Distinct from the existing /api/resume-analyzer routes (analyzer.routes.js),
 * which take a multipart file upload (PDF/DOCX) and use the ResumeAnalysis
 * model. This route accepts plain resume text as JSON and goes through the
 * shared lib/ai architecture (aiService/historyService/usage middleware),
 * with a graceful local fallback when the active provider is unavailable.
 * No PDF parsing or file upload here — text only, per spec.
 *
 * Middleware order matters:
 *   requireAuth        -> attaches req.user
 *   checkUsageLimit()  -> attaches req.usage, blocks with 429 if exhausted
 *   analyzeResume       -> does the work, responds, calls next() only on success
 *   incrementUsage()   -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { analyzeResume } from "../../controllers/ai/resumeAnalyzer.controller.js";

const FEATURE = "resumeAnalyzer";

const router = Router();

router.post(
  "/analyze",
  requireAuth,
  checkUsageLimit(FEATURE),
  analyzeResume,
  incrementUsage(FEATURE),
);

export default router;
