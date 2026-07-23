/**
 * lib/cache/aiCache.js
 * ---------------------------------------------------------------------------
 * Response cache for repeated AI requests. Cache key is built from
 * userId + feature + a SHA-256 hash of the (sanitized) input, so identical
 * requests from the same user for the same feature reuse a prior response
 * instead of re-calling the provider.
 *
 * Uses node:crypto (built-in, no new dependency) for hashing and the shared
 * lazy Redis client from lib/cache/redis.js for storage. Every function
 * degrades to a safe no-op when Redis is unavailable/unconfigured — caching
 * is a performance optimization, never a request-blocking dependency.
 */

import crypto from 'node:crypto';
import { getRedisClient } from './redis.js';
import { logger } from '../monitoring/logger.js';

const DEFAULT_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS) || 3600;
const KEY_PREFIX = 'ai:cache';

/**
 * @param {string|null|undefined} userId
 * @param {string} feature
 * @param {string} input - Sanitized prompt (and any other request-shaping
 *   fields the caller wants included, e.g. system instructions) as a single
 *   string; the caller decides what belongs in the cache identity.
 * @returns {string}
 */
export function buildCacheKey(userId, feature, input) {
  const hash = crypto.createHash('sha256').update(String(input ?? '')).digest('hex');
  return `${KEY_PREFIX}:${userId || 'anon'}:${feature || 'unknown'}:${hash}`;
}

/**
 * @param {string|null|undefined} userId
 * @param {string} feature
 * @param {string} input
 * @returns {Promise<any|null>} The cached value, or null on a miss/unavailable cache.
 */
export async function getCachedResponse(userId, feature, input) {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const key = buildCacheKey(userId, feature, input);
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('[aiCache] Cache read failed — proceeding without cache.', { feature, error: err.message });
    return null;
  }
}

/**
 * @param {string|null|undefined} userId
 * @param {string} feature
 * @param {string} input
 * @param {any} value - Must be JSON-serializable.
 * @param {number} [ttlSeconds] - Defaults to AI_CACHE_TTL_SECONDS (or 3600s).
 * @returns {Promise<boolean>} true if the value was cached.
 */
export async function setCachedResponse(userId, feature, input, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const key = buildCacheKey(userId, feature, input);
    await client.set(key, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
    return true;
  } catch (err) {
    logger.warn('[aiCache] Cache write failed — response was still returned to the user.', {
      feature,
      error: err.message,
    });
    return false;
  }
}

export default { buildCacheKey, getCachedResponse, setCachedResponse };
