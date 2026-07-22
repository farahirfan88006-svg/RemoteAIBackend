import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import healthRoutes from "./routes/health.routes.js";
import jobsRoutes from "./routes/jobs.routes.js";
import searchRoutes from "./routes/search.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import companiesRoutes from "./routes/companies.routes.js";
import countriesRoutes from "./routes/countries.routes.js";
import tagsRoutes from "./routes/tags.routes.js";
import authRoutes from "./routes/auth.routes.js";
import resumesRoutes from "./routes/resumes.routes.js";
import coverLettersRoutes from "./routes/coverLetters.routes.js";
import analyzerRoutes from "./routes/analyzer.routes.js";
import resumeAnalyzerAIRoutes from "./routes/ai/resumeAnalyzer.routes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

/**
 * Builds and configures the Express application.
 *
 * Kept separate from server.js on purpose: this module never calls
 * `listen()`, which means it can be imported by tests or other tooling
 * without opening a real network port — server.js is the only place the
 * process actually starts listening.
 *
 * Phase 1 wired up only infrastructure (security headers, CORS, rate
 * limiting, JSON parsing, health check, error handling). Phase 2 adds the
 * business read API — jobs, search, categories, companies — all mounted
 * under /api, matching what the frontend's NEXT_PUBLIC_API_URL already
 * points at (e.g. http://localhost:5000/api). /api/countries (dynamic
 * category/country filtering) was added later alongside it.
 */
export function createApp() {
  const app = express();

  // Security headers — cheap, always-on baseline.
  app.use(helmet());

  // Only the configured frontend origin(s) may call this API.
  app.use(
    cors({
      origin: env.corsOrigin,
    }),
  );

  // Global rate limit — all current/future endpoints are public reads of
  // similar cost, so one global limiter is sufficient (see spec §14).
  app.use(
    rateLimit({
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
    }),
  );

  app.use(express.json());

  app.use("/health", healthRoutes);

  app.use("/api/jobs", jobsRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/categories", categoriesRoutes);
  app.use("/api/companies", companiesRoutes);
  app.use("/api/countries", countriesRoutes);
  app.use("/api/tags", tagsRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/resumes", resumesRoutes);
  app.use("/api/cover-letters", coverLettersRoutes);
  app.use("/api/resume-analyzer", analyzerRoutes);
  // Text-only, AI-service-backed Resume Analyzer (distinct from the
  // file-upload-based /api/resume-analyzer above).
  app.use("/api/ai/resume-analyzer", resumeAnalyzerAIRoutes);

  // No routes matched above -> 404, then centralized error formatting.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
