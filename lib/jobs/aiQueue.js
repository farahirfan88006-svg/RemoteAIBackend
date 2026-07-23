/**
 * lib/jobs/aiQueue.js
 * ---------------------------------------------------------------------------
 * The "ai-tasks" queue: an optional path for offloading a heavy AI feature
 * call to a background worker (lib/jobs/workers/ai.worker.js) instead of
 * running it synchronously inside a request handler.
 *
 * This does NOT replace the existing synchronous flow in any controller —
 * no controller has been migrated to call enqueueAIJob() instead of
 * aiService.runAIFeature() directly. It's available for a future route
 * (e.g. a "long-running analysis" endpoint) that wants to return
 * immediately with a job id and let the client poll/subscribe for the
 * result, without duplicating the queue-wiring boilerplate.
 *
 * If Redis/BullMQ aren't configured, enqueueAIJob() returns null and logs a
 * warning — callers should treat that as "queue unavailable, run
 * synchronously instead" rather than as a hard failure.
 */

import { createQueue } from "./queue.js";
import { logger } from "../monitoring/logger.js";

export const AI_QUEUE_NAME = "ai-tasks";

let queuePromise = null;

async function getAIQueue() {
  if (!queuePromise) {
    queuePromise = createQueue(AI_QUEUE_NAME);
  }
  return queuePromise;
}

/**
 * @param {Object} jobData - Passed verbatim to aiService.runAIFeature() by
 *   the worker: { feature, user, prompt, options }.
 * @param {Object} [jobOptions] - Extra BullMQ job options (attempts, delay, etc.).
 * @returns {Promise<string|null>} The BullMQ job id, or null if the queue is unavailable.
 */
export async function enqueueAIJob(jobData, jobOptions = {}) {
  const queue = await getAIQueue();

  if (!queue) {
    logger.warn("[aiQueue] Queue unavailable — job was not enqueued; caller should run the request synchronously.", {
      feature: jobData?.feature,
    });
    return null;
  }

  try {
    const job = await queue.add("run-ai-feature", jobData, {
      removeOnComplete: true,
      removeOnFail: 50,
      ...jobOptions,
    });
    return job.id;
  } catch (err) {
    logger.error("[aiQueue] Failed to enqueue job", { feature: jobData?.feature, error: err.message });
    return null;
  }
}

export default { AI_QUEUE_NAME, enqueueAIJob };
