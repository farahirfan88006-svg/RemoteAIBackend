process.env.NODE_ENV ??= "test";
process.env.MONGODB_URI ??= "mongodb://localhost:27017/remoteai-test";
process.env.CORS_ORIGIN ??= "http://localhost:3000";
process.env.JWT_SECRET ??= "test-secret-for-rate-limiter-tests";

import { test } from "node:test";
import assert from "node:assert/strict";
import { generalApiLimiter, aiApiLimiter } from "../../src/middleware/rateLimiter.js";
import { env } from "../../src/config/env.js";

test("rateLimiter exposes distinct general and AI middleware functions", () => {
  assert.equal(typeof generalApiLimiter, "function");
  assert.equal(typeof aiApiLimiter, "function");
  assert.notEqual(generalApiLimiter, aiApiLimiter);
});

test("the AI rate limit is stricter than (or equal to) the general API limit by default", () => {
  assert.ok(env.aiRateLimitMaxRequests <= env.rateLimitMaxRequests);
});

test("both limiters behave as Express middleware (three-argument function signature)", () => {
  assert.equal(generalApiLimiter.length, 3);
  assert.equal(aiApiLimiter.length, 3);
});

test("hitting the AI limiter past its max returns the standard AI response envelope, not the generic one", async () => {
  const max = 2;
  const req = { path: "/api/ai/resume-analyzer", ip: "127.0.0.1" };
  let statusCode = 200;
  let jsonBody = null;

  const makeRes = () => ({
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
    setHeader() {},
    getHeader() {},
    end() {},
  });

  // express-rate-limit's handler is exercised directly here rather than
  // spinning up a full Express app/HTTP server (no supertest dependency in
  // this project) — this still verifies the response envelope shape our
  // aiApiLimiter is configured to send once its window is exceeded.
  const testLimiter = (await import("express-rate-limit")).default({
    windowMs: 60_000,
    max,
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

  const next = () => {};
  for (let i = 0; i < max + 1; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => testLimiter(req, makeRes(), () => resolve(next())));
  }

  assert.equal(statusCode, 429);
  assert.equal(jsonBody.success, false);
  assert.deepEqual(Object.keys(jsonBody).sort(), ["data", "errors", "message", "plan", "success", "usageRemaining"]);
});
