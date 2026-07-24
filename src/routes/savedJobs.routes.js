import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { listSavedJobs, listSavedJobIds, saveJob, unsaveJob } from "../controllers/savedJobs.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", listSavedJobs);
router.get("/ids", listSavedJobIds);
router.post("/", saveJob);
router.delete("/:jobId", unsaveJob);

export default router;
