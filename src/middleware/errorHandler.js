import { env } from "../config/env.js";

/**
 * Single centralized error -> HTTP response mapper (see spec §8).
 *
 * Every route/controller either returns normally or calls `next(err)`.
 * No controller formats its own error response — that guarantees every
 * error the API returns uses the same envelope shape:
 *
 *   { success: false, error: { code, message } }
 *
 * Errors are expected to optionally carry `statusCode` and `code`
 * (see notFound.js for an example). Anything without those is treated as
 * an unexpected internal failure: logged with its full stack, and
 * reported to the client only as a generic 500 so internals are never
 * leaked.
 */

const DEFAULT_STATUS = 500;
const DEFAULT_CODE = "INTERNAL_ERROR";

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || DEFAULT_STATUS;
  const code = err.code || DEFAULT_CODE;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.method} ${req.originalUrl} ->`, err.stack || err.message);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: isServerError && env.nodeEnv === "production" ? "Internal server error" : err.message,
    },
  });
}
