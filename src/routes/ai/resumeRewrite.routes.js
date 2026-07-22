/**
 * src/routes/ai/resumeRewrite.routes.js
 * ---------------------------------------------------------------------------
 * Mounted at /api/ai/resume-rewrite in app.js.
 *
 * Accepts plain resume text + a target role as JSON and goes through the
 * shared lib/ai architecture (aiService/historyService/usage middleware),
 * with a graceful local fallback when the active provider is unavailable —
 * same pattern as resumeAnalyzer.routes.js.
 *
 * Middleware order matters:
 *   requireAuth        -> attaches req.user
 *   checkUsageLimit()  -> attaches req.usage, blocks with 429 if exhausted
 *   rewriteResume      -> does the work, responds, calls next() only on success
 *   incrementUsage()   -> records usage for the request that was just served
 */

import { Router } from "express";
import requireAuth from "../../middleware/requireAuth.js";
import checkUsageLimit from "../../middleware/checkUsageLimit.js";
import incrementUsage from "../../middleware/incrementUsage.js";
import { rewriteResume } from "../../controllers/ai/resumeRewrite.controller.js";

const FEATURE = "resumeRewrite";

const router = Router();

router.post(
  "/rewrite",
  requireAuth,
  checkUsageLimit(FEATURE),
  rewriteResume,
  incrementUsage(FEATURE),
);

export default router;
