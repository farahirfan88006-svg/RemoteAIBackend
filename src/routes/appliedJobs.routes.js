import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  listAppliedJobs,
  applyToJob,
  updateApplication,
  deleteApplication,
} from "../controllers/appliedJobs.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", listAppliedJobs);
router.post("/", applyToJob);
router.put("/:id", updateApplication);
router.delete("/:id", deleteApplication);

export default router;
