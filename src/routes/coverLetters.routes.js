import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  generateLetter,
  listLetters,
  getLetter,
  updateLetter,
  deleteLetter,
} from "../controllers/coverLetters.controller.js";

const router = Router();

router.use(requireAuth);

router.post("/generate", generateLetter);
router.get("/", listLetters);
router.get("/:id", getLetter);
router.put("/:id", updateLetter);
router.delete("/:id", deleteLetter);

export default router;
