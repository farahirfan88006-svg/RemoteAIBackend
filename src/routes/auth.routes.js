import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  register,
  login,
  logout,
  getMe,
  updateMe,
  changePassword,
} from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

/**
 * Mounted at /api/auth in app.js.
 *
 * register/login get their own, stricter rate limiter on top of the
 * global one already applied in app.js — credential-guessing endpoints
 * are a meaningfully different risk profile from the rest of this
 * (otherwise all-public-read) API, so they're worth limiting separately
 * rather than only sharing the general 300-req/15min budget.
 */
const router = Router();

const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many attempts, please try again later." },
  },
});

router.post("/register", authAttemptLimiter, register);
router.post("/login", authAttemptLimiter, login);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, getMe);
router.put("/me", requireAuth, updateMe);
router.put("/change-password", requireAuth, changePassword);

export default router;
