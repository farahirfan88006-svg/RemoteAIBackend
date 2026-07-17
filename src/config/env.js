import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * Central environment configuration.
 *
 * This is the ONLY place in the codebase that reads `process.env` directly.
 * Every other module imports the parsed `env` object from here, so:
 *   - a variable's name/default only needs to change in one place
 *   - required variables are validated once, at boot, instead of failing
 *     unpredictably deep inside a request handler or the sync scheduler
 *
 * If a required variable is missing, the process exits immediately with a
 * clear message rather than starting in a broken, half-configured state.
 */

const REQUIRED_VARS = ["MONGODB_URI", "NODE_ENV", "CORS_ORIGIN", "JWT_SECRET"];

function readEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key] || process.env[key].trim() === "");

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[env] Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill these in before starting the server.",
    );
    process.exit(1);
  }

  return {
    nodeEnv: process.env.NODE_ENV,
    port: Number(process.env.PORT) || 5000,
    mongodbUri: process.env.MONGODB_URI,
    corsOrigin: process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),

    // Sync scheduling — not used until Phase 2, validated/typed here now so
    // the config surface is defined once and doesn't change shape later.
    syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS) || 6,
    syncOnBoot: process.env.SYNC_ON_BOOT === "true",

    // Rate limiting
    rateLimitWindowMinutes: Number(process.env.RATE_LIMIT_WINDOW_MINUTES) || 15,
    rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 300,

    // Auth (Phase 4) — JWT_SECRET is REQUIRED (see above): an auth system
    // whose token-signing secret silently defaulted to something would be
    // a real security bug, not just a missing-config inconvenience, so it
    // gets the same fail-fast treatment as MONGODB_URI rather than a
    // fallback value.
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 12,

    // Resume Analyzer upload limits (Phase 6)
    resumeUploadMaxBytes: Number(process.env.RESUME_UPLOAD_MAX_BYTES) || 5 * 1024 * 1024,

    // USAJobs (Phase 3 sync source) — both required by their API for any
    // request to succeed. Left optional here (not in REQUIRED_VARS)
    // because the sync engine is built to skip this one provider
    // gracefully, not fail startup, if they're unset.
    usajobsApiKey: process.env.USAJOBS_API_KEY || "",
    usajobsUserAgent: process.env.USAJOBS_USER_AGENT || "",

    // Wellfound / YC Jobs (Phase 3 sync sources) — neither platform
    // publishes a free public jobs API, so these sources are pluggable
    // clients for a feed you provide yourself (see the source files for
    // details). Both are skipped gracefully, not fatally, if unset.
    wellfoundFeedUrl: process.env.WELLFOUND_FEED_URL || "",
    wellfoundApiKey: process.env.WELLFOUND_API_KEY || "",
    ycjobsFeedUrl: process.env.YCJOBS_FEED_URL || "",
    ycjobsApiKey: process.env.YCJOBS_API_KEY || "",
  };
}

export const env = readEnv();
