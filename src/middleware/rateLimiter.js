import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

/**
 * src/middleware/rateLimiter.js
 * ---------------------------------------------------------------------------
 * Centralizes both rate limiters the API uses:
 *   - generalApiLimiter: the same general-purpose limiter app.js already
 *     applied inline (moved here so the general and AI limits live next to
 *     each other, and so rateLimiter.test.js can import/verify both
 *     configurations directly). Behavior/response shape is unchanged from
 *     what app.js had before.
 *   - aiApiLimiter: a new, stricter limiter mounted only on /api/ai/* (AI
 *     calls are far more expensive — provider cost, latency, tokens — than
 *     a typical read endpoint, so they get a tighter window/count and a
 *     response shaped like the standard AI response envelope
 *     { success, message, plan, usageRemaining, data, errors } instead of
 *     the general limiter's generic error shape).
 *
 * Neither limiter touches req.user or auth in any way — both run
 * independently of requireAuth/requirePremium and never block/replace them.
 */

export const generalApiLimiter = rateLimit({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many requests, please try again later." },
  },
  // Render's own uptime checks shouldn't count against real traffic.
  skip: (req) => req.path === "/health",
});

export const aiApiLimiter = rateLimit({
  windowMs: env.aiRateLimitWindowMinutes * 60 * 1000,
  max: env.aiRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many AI requests. Please slow down and try again shortly.",
    plan: null,
    usageRemaining: null,
    data: null,
    errors: ["RATE_LIMITED"],
  },
});

export default { generalApiLimiter, aiApiLimiter };
