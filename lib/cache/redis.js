/**
 * lib/cache/redis.js
 * ---------------------------------------------------------------------------
 * Lazy, singleton Redis client shared by the AI response cache
 * (lib/cache/aiCache.js) and the background job queue (lib/jobs/queue.js).
 *
 * Deliberately defensive, matching the rest of Phase 11's "never crash the
 * API" requirement:
 *   - If REDIS_URL isn't set, caching/jobs are silently disabled (a single
 *     warning is logged once) rather than the app failing to boot.
 *   - If the `ioredis` package isn't installed, the dynamic import is
 *     caught and caching/jobs are disabled the same way — this project's
 *     package.json lists ioredis as a dependency for Phase 11, but this
 *     file doesn't assume `npm install` has been run in every environment
 *     (e.g. CI running only unit tests).
 *   - Connection errors are logged, never thrown out of getRedisClient().
 *
 * Every consumer must treat a `null` return as "cache/queue unavailable,
 * proceed without it" — never as an error to surface to the end user.
 */

import { logger } from '../monitoring/logger.js';

let clientPromise = null;
let warnedMissingUrl = false;

/**
 * @returns {Promise<import('ioredis').Redis|null>} A connected ioredis
 *   client, or null if Redis is unavailable/unconfigured/uninstalled.
 */
export async function getRedisClient() {
  const url = process.env.REDIS_URL;

  if (!url) {
    if (!warnedMissingUrl) {
      logger.warn('[redis] REDIS_URL is not set — AI response caching and background jobs are disabled.');
      warnedMissingUrl = true;
    }
    return null;
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      let RedisModule;
      try {
        RedisModule = await import('ioredis');
      } catch (err) {
        logger.warn('[redis] "ioredis" is not installed — run `npm install` to enable AI caching/jobs.', {
          error: err.message,
        });
        return null;
      }

      try {
        const Redis = RedisModule.default || RedisModule;
        const client = new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        });

        client.on('error', (err) => {
          logger.error('[redis] connection error', { error: err.message });
        });

        await client.connect();
        logger.info('[redis] Connected.');
        return client;
      } catch (err) {
        logger.error('[redis] Failed to initialize client — caching/jobs disabled.', { error: err.message });
        return null;
      }
    })();
  }

  return clientPromise;
}

/**
 * Closes the shared Redis connection, if one was ever opened. Intended for
 * graceful shutdown / test teardown, not for regular request handling.
 */
export async function closeRedisClient() {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = null;
  if (client) {
    try {
      await client.quit();
    } catch (err) {
      logger.warn('[redis] Error while closing connection', { error: err.message });
    }
  }
}

export default { getRedisClient, closeRedisClient };
