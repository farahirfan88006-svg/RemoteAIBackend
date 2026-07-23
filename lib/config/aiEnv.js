/**
 * lib/config/aiEnv.js
 * ---------------------------------------------------------------------------
 * Validates the Phase 11 AI-related environment configuration at startup.
 *
 * Unlike src/config/env.js (which exits the process if a *required* core
 * variable like MONGODB_URI/JWT_SECRET is missing), this validation is
 * intentionally non-fatal: AI features, caching, and background jobs are
 * all designed to degrade gracefully (free provider / no cache / no queue)
 * rather than be a reason the whole API refuses to boot. Problems are
 * logged as warnings so they're visible in production logs without taking
 * the service down.
 */

import { logger } from "../monitoring/logger.js";

const VALID_PROVIDERS = ["free", "openai", "gemini", "openrouter"];

const REQUIRED_KEY_BY_PROVIDER = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * @returns {{ provider: string, valid: boolean, warnings: string[] }}
 */
export function validateAIEnv() {
  const provider = (process.env.AI_PROVIDER || process.env.AI_DEFAULT_PROVIDER || "free").toLowerCase();
  const warnings = [];

  if (!VALID_PROVIDERS.includes(provider)) {
    warnings.push(
      `AI_PROVIDER="${provider}" is not recognized (expected one of ${VALID_PROVIDERS.join(", ")}) — requests will fall back to the "free" provider.`,
    );
  }

  const requiredKey = REQUIRED_KEY_BY_PROVIDER[provider];
  if (requiredKey && !process.env[requiredKey]) {
    warnings.push(
      `AI_PROVIDER is set to "${provider}" but ${requiredKey} is not set — AI requests will fall back to the "free" provider until it's configured.`,
    );
  }

  if (!process.env.REDIS_URL) {
    warnings.push(
      "REDIS_URL is not set — AI response caching and background AI jobs are disabled; the app will keep working synchronously and uncached.",
    );
  }

  if (warnings.length > 0) {
    warnings.forEach((warning) => logger.warn(`[aiEnv] ${warning}`));
  } else {
    logger.info("[aiEnv] AI environment configuration looks good.", { provider });
  }

  return { provider, valid: warnings.length === 0, warnings };
}

export default validateAIEnv;
