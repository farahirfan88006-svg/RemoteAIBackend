import { Router } from "express";
import { listCountries } from "../controllers/countries.controller.js";

/**
 * Mounted at /api/countries in app.js.
 */
const router = Router();

router.get("/", listCountries);

export default router;
