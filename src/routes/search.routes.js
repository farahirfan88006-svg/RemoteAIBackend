import { Router } from "express";
import { search } from "../controllers/search.controller.js";

/**
 * Mounted at /api/search in app.js.
 */
const router = Router();

router.get("/", search);

export default router;
