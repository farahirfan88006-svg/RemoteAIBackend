import { Router } from "express";
import { listJobs, getJob, getInterviewQuestions, getSalaryEstimate } from "../controllers/jobs.controller.js";

/**
 * Mounted at /api/jobs in app.js.
 */
const router = Router();

router.get("/", listJobs);
router.get("/:slug", getJob);
router.get("/:slug/interview-questions", getInterviewQuestions);
router.get("/:slug/salary-estimate", getSalaryEstimate);

export default router;
