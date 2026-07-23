import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { generalApiLimiter, aiApiLimiter } from "./middleware/rateLimiter.js";
import { requestLoggingMiddleware } from "../lib/monitoring/metrics.js";
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
import resumeRewriteAIRoutes from "./routes/ai/resumeRewrite.routes.js";
import careerCoachAIRoutes from "./routes/ai/careerCoach.routes.js";
import coverLetterAIRoutes from "./routes/ai/coverLetterAI.routes.js";
import mockInterviewAIRoutes from "./routes/ai/mockInterview.routes.js";
import jobMatchScoreAIRoutes from "./routes/ai/jobMatchScore.routes.js";
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
  // (Phase 11: extracted into src/middleware/rateLimiter.js so the AI-
  // specific limiter below it can live alongside it; behavior unchanged.)
  app.use(generalApiLimiter);

  // Phase 11: lightweight in-process request metrics (counts + response
  // times per route) — see lib/monitoring/metrics.js. Logs nothing by
  // itself; only feeds getMetricsSnapshot().
  app.use(requestLoggingMiddleware);

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
  // Phase 11: stricter rate limit for all AI-service-backed endpoints
  // below (they're far more expensive than a typical read endpoint) —
  // applied once, centrally, since every AI route is mounted under
  // /api/ai/*. Does not replace or run before requireAuth/requirePremium
  // on the individual routes; it only limits request *rate*.
  app.use("/api/ai", aiApiLimiter);
  // Text-only, AI-service-backed Resume Analyzer (distinct from the
  // file-upload-based /api/resume-analyzer above).
  app.use("/api/ai/resume-analyzer", resumeAnalyzerAIRoutes);
  // Text-only, AI-service-backed Resume Rewrite (tailors resume text to a
  // target role), following the same pattern as the Resume Analyzer above.
  app.use("/api/ai/resume-rewrite", resumeRewriteAIRoutes);
  // Text-only, AI-service-backed Career Coach (career roadmap, skills gaps,
  // learning recommendations, resume/job-search/interview advice),
  // following the same pattern as the Resume Analyzer / Resume Rewrite above.
  app.use("/api/ai/career-coach", careerCoachAIRoutes);
  // Text-only, AI-service-backed Cover Letter generator (produces a full,
  // personalized cover letter from applicant/resume/job/company details),
  // following the same pattern as the Resume Analyzer / Resume Rewrite /
  // Career Coach above.
  app.use("/api/ai/cover-letter", coverLetterAIRoutes);
  // Text-only, AI-service-backed Mock Interview (interview questions, model
  // answers, evaluation criteria, improvement tips, follow-up questions, and
  // prep advice for technical/HR/behavioral interviews), following the same
  // pattern as the Resume Analyzer / Resume Rewrite / Career Coach / Cover
  // Letter AI above.
  app.use("/api/ai/mock-interview", mockInterviewAIRoutes);
  // Text-only, AI-service-backed Job Match Score. The score itself is
  // always computed by a deterministic backend algorithm (skills/tech/
  // experience/education matching); AI is used only to optionally add an
  // explanation, improvement suggestions, and career advice on top of the
  // already-final score, following the same pattern as the Resume Analyzer /
  // Resume Rewrite / Career Coach / Cover Letter AI / Mock Interview above.
  app.use("/api/ai/job-match-score", jobMatchScoreAIRoutes);

  // No routes matched above -> 404, then centralized error formatting.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
