import { Router } from "express";
import { listTags } from "../controllers/tags.controller.js";

/**
 * Mounted at /api/tags in app.js.
 */
const router = Router();

router.get("/", listTags);

export default router;
