import { Router } from "express";
import { isDatabaseConnected } from "../config/db.js";

/**
 * Infrastructure health check — used by Render's health checks and for
 * local verification that the process is up and the database connection
 * is live. Deliberately not part of the /api/* business surface (no
 * pagination, no success/error envelope) since it's a platform-level
 * probe, not a data endpoint.
 */
const router = Router();

router.get("/", (req, res) => {
  const connected = isDatabaseConnected();

  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "degraded",
    database: connected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

export default router;
