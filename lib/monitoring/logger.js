/**
 * lib/monitoring/logger.js
 * ---------------------------------------------------------------------------
 * Small, dependency-free structured logger used across the AI production
 * layer (providers, cache, jobs, aiService). Intentionally does not pull in
 * a logging library (winston/pino/etc.) — this project has none installed,
 * and console.* with a consistent JSON shape is enough for Render's log
 * aggregation to pick up.
 *
 * Every log line is a single-line JSON object: { timestamp, level, message,
 * ...meta }, and any meta key that looks sensitive (password, token, apiKey,
 * secret, authorization, email) is redacted before it's ever stringified —
 * so accidentally logging a request payload can't leak credentials or PII.
 *
 * Level is controlled by LOG_LEVEL (error < warn < info < debug), defaulting
 * to "info". Set LOG_LEVEL=debug locally for verbose provider/cache tracing.
 */

const LEVELS = ['error', 'warn', 'info', 'debug'];

const SENSITIVE_KEY_PATTERN = /password|token|secret|apikey|api_key|authorization|email/i;

function currentLevel() {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS.includes(configured) ? configured : 'info';
}

function shouldLog(level) {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(currentLevel());
}

/**
 * Shallow-redacts any meta key whose name suggests sensitive content.
 * Deliberately shallow: this is a last-line safety net, not a substitute
 * for not logging sensitive data in the first place.
 * @param {Object} meta
 * @returns {Object}
 */
function redact(meta) {
  if (!meta || typeof meta !== 'object') return {};

  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    clean[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return clean;
}

function write(level, message, meta) {
  if (!shouldLog(level)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redact(meta),
  };

  const line = JSON.stringify(entry);

  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};

export default logger;
