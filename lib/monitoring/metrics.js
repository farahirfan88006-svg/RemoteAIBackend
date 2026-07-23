/**
 * lib/monitoring/metrics.js
 * ---------------------------------------------------------------------------
 * Lightweight in-process metrics. No external metrics backend (Prometheus,
 * Datadog, etc.) is configured in this project, so this keeps rolling
 * counters/timings in memory — enough to log periodically or expose via an
 * internal admin endpoint later, without adding a new infrastructure
 * dependency for Phase 11.
 *
 * Two entry points:
 *   - requestLoggingMiddleware(req, res, next): mount once in app.js, tracks
 *     total requests, per-route counts, and response times.
 *   - recordAICall({ feature, provider, success, tokens }): called from
 *     aiService.js after every provider invocation to track AI-specific
 *     usage, error rate, and token consumption (when a provider reports it).
 *
 * Never logs request/response bodies, headers, or user identifiers here —
 * only counts and routes — so this file carries no sensitive-data risk on
 * its own.
 */

const state = {
  requests: { total: 0, byRoute: {} },
  aiCalls: { total: 0, errors: 0, byFeature: {}, byProvider: {} },
  responseTimesMs: [],
  tokenUsage: { total: 0, byProvider: {} },
};

const MAX_TRACKED_RESPONSE_TIMES = 1000;

/**
 * Express middleware: tracks request counts and response time per route.
 */
export function requestLoggingMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const routeKey = `${req.method} ${req.baseUrl || req.path || req.url}`;

    state.requests.total += 1;
    state.requests.byRoute[routeKey] = (state.requests.byRoute[routeKey] || 0) + 1;

    state.responseTimesMs.push(durationMs);
    if (state.responseTimesMs.length > MAX_TRACKED_RESPONSE_TIMES) {
      state.responseTimesMs.shift();
    }
  });

  next();
}

/**
 * Records a single AI provider invocation's outcome.
 *
 * @param {Object} params
 * @param {string} [params.feature]
 * @param {string} [params.provider]
 * @param {boolean} params.success
 * @param {number|null} [params.tokens] - Total tokens used, if the provider reported it.
 */
export function recordAICall({ feature, provider, success, tokens } = {}) {
  state.aiCalls.total += 1;
  if (!success) state.aiCalls.errors += 1;

  if (feature) {
    state.aiCalls.byFeature[feature] = (state.aiCalls.byFeature[feature] || 0) + 1;
  }
  if (provider) {
    state.aiCalls.byProvider[provider] = (state.aiCalls.byProvider[provider] || 0) + 1;
  }
  if (typeof tokens === 'number' && Number.isFinite(tokens)) {
    state.tokenUsage.total += tokens;
    if (provider) {
      state.tokenUsage.byProvider[provider] = (state.tokenUsage.byProvider[provider] || 0) + tokens;
    }
  }
}

/**
 * @returns {Object} A point-in-time snapshot of all tracked metrics.
 */
export function getMetricsSnapshot() {
  const times = state.responseTimesMs;
  const averageResponseTimeMs = times.length
    ? Math.round((times.reduce((sum, t) => sum + t, 0) / times.length) * 100) / 100
    : 0;

  return {
    requests: { ...state.requests, byRoute: { ...state.requests.byRoute } },
    aiCalls: {
      ...state.aiCalls,
      byFeature: { ...state.aiCalls.byFeature },
      byProvider: { ...state.aiCalls.byProvider },
    },
    tokenUsage: { ...state.tokenUsage, byProvider: { ...state.tokenUsage.byProvider } },
    averageResponseTimeMs,
  };
}

export default { requestLoggingMiddleware, recordAICall, getMetricsSnapshot };
