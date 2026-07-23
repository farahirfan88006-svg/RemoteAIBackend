/**
 * lib/jobs/workers/ai.worker.js
 * ---------------------------------------------------------------------------
 * Standalone worker process that consumes the "ai-tasks" queue
 * (lib/jobs/aiQueue.js) and runs each job through the same
 * aiService.runAIFeature() that every synchronous controller already uses
 * — so a queued job produces an identical result shape to a direct call.
 *
 * This file is NOT imported by server.js / app.js and does not start
 * automatically when the API boots — per Phase 11 scope, the existing
 * synchronous request flow must keep working unmodified. Run this as a
 * separate process/dyno only where background processing is actually
 * wanted:
 *
 *   node lib/jobs/workers/ai.worker.js
 *   # or: npm run worker:ai
 *
 * If REDIS_URL/BullMQ aren't configured, createWorker() resolves to null
 * and this process logs a warning and exits cleanly (code 0) rather than
 * crash-looping — safe to include in a deploy that doesn't use it yet.
 */

import { createWorker } from "../queue.js";
import { AI_QUEUE_NAME } from "../aiQueue.js";
import { runAIFeature } from "../../ai/services/aiService.js";
import { logger } from "../../monitoring/logger.js";

async function processor(job) {
  const { feature, user, prompt, options } = job.data || {};
  logger.info(`[ai.worker] Processing job ${job.id}`, { feature });

  const result = await runAIFeature({ feature, user, prompt, options });

  if (!result.success) {
    // Throwing marks the BullMQ job as failed (and eligible for retry per
    // the queue's configured attempts) instead of silently succeeding with
    // an error payload.
    throw new Error(result.message || `AI job for feature "${feature}" failed.`);
  }

  return result;
}

async function start() {
  const worker = await createWorker(AI_QUEUE_NAME, processor, {
    concurrency: Number(process.env.AI_WORKER_CONCURRENCY) || 2,
  });

  if (!worker) {
    logger.warn("[ai.worker] Worker not started — Redis/BullMQ is not configured/installed.");
    process.exit(0);
  }

  worker.on("completed", (job) => logger.info(`[ai.worker] Job ${job.id} completed`, { feature: job.data?.feature }));
  worker.on("failed", (job, err) =>
    logger.error(`[ai.worker] Job ${job?.id} failed`, { feature: job?.data?.feature, error: err?.message }),
  );

  logger.info("[ai.worker] AI background worker started and listening for jobs.");
}

start().catch((err) => {
  logger.error("[ai.worker] Fatal error starting worker", { error: err.message });
  process.exit(1);
});
