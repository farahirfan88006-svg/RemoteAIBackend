import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  listResumes,
  createResume,
  generateResume,
  getResume,
  updateResume,
  deleteResume,
  duplicateResume,
  setDefaultResume,
} from "../controllers/resumes.controller.js";

/**
 * Mounted at /api/resumes in app.js. Every route requires auth — there
 * is no public read access to resumes, unlike every other resource in
 * this API.
 */
const router = Router();

router.use(requireAuth);

router.get("/", listResumes);
router.post("/", createResume);
router.post("/generate", generateResume);
router.get("/:id", getResume);
router.put("/:id", updateResume);
router.delete("/:id", deleteResume);
router.post("/:id/duplicate", duplicateResume);
router.put("/:id/set-default", setDefaultResume);

export default router;
