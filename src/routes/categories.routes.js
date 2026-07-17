import { Router } from "express";
import { listCategories } from "../controllers/categories.controller.js";

/**
 * Mounted at /api/categories in app.js.
 */
const router = Router();

router.get("/", listCategories);

export default router;
