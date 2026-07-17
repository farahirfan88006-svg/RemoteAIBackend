import { Router } from "express";
import { listCompanies } from "../controllers/companies.controller.js";

/**
 * Mounted at /api/companies in app.js.
 */
const router = Router();

router.get("/", listCompanies);

export default router;
