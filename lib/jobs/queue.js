/**
 * lib/jobs/queue.js
 * ---------------------------------------------------------------------------
 * Thin, defensive wrapper around BullMQ for background AI job processing.
 * Nothing in this file is imported by the request/response path of any
 * existing controller — the synchronous flow (aiService.runAIFeature called
 * directly from a controller) is untouched and remains the default. This
 * only exists so heavy AI work *can* be offloaded to a worker process when
 * REDIS_URL + BullMQ are available (see lib/jobs/aiQueue.js and
 * lib/jobs/workers/ai.worker.js).
 *
 * Matches the "never crash the API" requirement:
 *   - If REDIS_URL is unset, createQueue()/createWorker() return null and
 *     log a warning instead of throwing.
 *   - If the `bullmq` (or `ioredis`) package isn't installed, the dynamic
 *     import is caught the same way.
 *   - Any other construction error (bad URL, auth failure) is caught and
 *     logged, never thrown out of these functions.
 */

import { logger } from "../monitoring/logger.js";

let bullmqPromise = null;

async function loadBullMQ() {
  if (!bullmqPromise) {
    bullmqPromise = import("bullmq").catch((err) => {
      logger.warn('[jobs] "bullmq" is not installed — background AI job queue disabled.', {
        error: err.message,
      });
      return null;
    });
  }
  return bullmqPromise;
}

async function buildConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const IORedisModule = await import("ioredis");
    const IORedis = IORedisModule.default || IORedisModule;
    // BullMQ requires maxRetriesPerRequest: null on its own connection.
    return new IORedis(url, { maxRetriesPerRequest: null });
  } catch (err) {
    logger.warn('[jobs] "ioredis" is not installed — background AI job queue disabled.', {
      error: err.message,
    });
    return null;
  }
}

/**
 * @param {string} name - Queue name.
 * @param {object} [options] - Extra BullMQ QueueOptions, merged in.
 * @returns {Promise<import('bullmq').Queue|null>}
 */
export async function createQueue(name, options = {}) {
  if (!process.env.REDIS_URL) {
    logger.warn(`[jobs] REDIS_URL is not set — queue "${name}" disabled.`);
    return null;
  }

  const bullmq = await loadBullMQ();
  if (!bullmq) return null;

  const connection = await buildConnection();
  if (!connection) return null;

  try {
    const { Queue } = bullmq;
    return new Queue(name, { connection, ...options });
  } catch (err) {
    logger.error(`[jobs] Failed to create queue "${name}"`, { error: err.message });
    return null;
  }
}

/**
 * @param {string} name - Queue name to consume.
 * @param {Function} processor - async (job) => result
 * @param {object} [options] - Extra BullMQ WorkerOptions, merged in.
 * @returns {Promise<import('bullmq').Worker|null>}
 */
export async function createWorker(name, processor, options = {}) {
  if (!process.env.REDIS_URL) {
    logger.warn(`[jobs] REDIS_URL is not set — worker "${name}" disabled.`);
    return null;
  }

  const bullmq = await loadBullMQ();
  if (!bullmq) return null;

  const connection = await buildConnection();
  if (!connection) return null;

  try {
    const { Worker } = bullmq;
    return new Worker(name, processor, { connection, ...options });
  } catch (err) {
    logger.error(`[jobs] Failed to create worker "${name}"`, { error: err.message });
    return null;
  }
}

export default { createQueue, createWorker };
