import cron from "node-cron";
import Job from "../models/Job.js";
import { generateUniqueJobSlug } from "../services/slug.service.js";
import { dedupeJobs, buildPrimaryKey, buildSecondaryKey, collidesWithExistingJob } from "../services/dedupe.service.js";
import { env } from "../config/env.js";

import * as greenhouseSource from "./sources/greenhouse.source.js";
import * as leverSource from "./sources/lever.source.js";
import * as ashbySource from "./sources/ashby.source.js";
import * as arbeitnowSource from "./sources/arbeitnow.source.js";
import * as usajobsSource from "./sources/usajobs.source.js";
import * as remoteokSource from "./sources/remoteok.source.js";
import * as remotiveSource from "./sources/remotive.source.js";
import * as himalayasSource from "./sources/himalayas.source.js";
import * as wellfoundSource from "./sources/wellfound.source.js";
import * as ycjobsSource from "./sources/ycjobs.source.js";

/**
 * runSync.js — the Phase 3 sync engine's orchestrator.
 *
 * Pipeline, one run:
 *   1. Fetch every source in parallel (a failing source is logged and
 *      contributes zero jobs — it never aborts the run).
 *   2. Dedupe the combined batch (dedupe.service.js).
 *   3. Bulk upsert into MongoDB (insert new, update changed, leave
 *      unchanged jobs alone) via Job.bulkWrite — no per-document
 *      save() calls.
 *   4. Deactivate jobs that used to exist for a successfully-synced
 *      source but weren't seen this run (isActive = false).
 *   5. Permanently delete jobs that have been inactive for 30+ days.
 *
 * Nothing here touches controllers, routes, or the query service —
 * this only ever writes to the Job collection; every existing read
 * endpoint keeps working exactly as before, now against real data.
 */

const SOURCES = [
  { name: "Greenhouse", key: "greenhouse", fetchJobs: greenhouseSource.fetchJobs },
  { name: "Lever", key: "lever", fetchJobs: leverSource.fetchJobs },
  { name: "Ashby", key: "ashby", fetchJobs: ashbySource.fetchJobs },
  { name: "Arbeitnow", key: "arbeitnow", fetchJobs: arbeitnowSource.fetchJobs },
  { name: "USAJobs", key: "usajobs", fetchJobs: usajobsSource.fetchJobs },
  { name: "RemoteOK", key: "remoteok", fetchJobs: remoteokSource.fetchJobs },
  { name: "Remotive", key: "remotive", fetchJobs: remotiveSource.fetchJobs },
  { name: "Himalayas", key: "himalayas", fetchJobs: himalayasSource.fetchJobs },
  { name: "Wellfound", key: "wellfound", fetchJobs: wellfoundSource.fetchJobs },
  { name: "YC Jobs", key: "ycjobs", fetchJobs: ycjobsSource.fetchJobs },
];

const INACTIVE_RETENTION_DAYS = 30;

// Fields that can change on re-sync and should trigger an update when
// they differ from what's already stored. Deliberately excludes
// identity fields (source, sourceId, slug) which never change for an
// existing document.
const MUTABLE_FIELDS = [
  "title",
  "summary",
  "description",
  "companyName",
  "companyLogo",
  "companyWebsite",
  "location",
  "country",
  "remoteType",
  "employmentType",
  "experienceLevel",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "category",
  "tags",
  "sourceUrl",
  "datePosted",
  "expiresAt",
];

function valuesEqual(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const aTime = a ? new Date(a).getTime() : null;
    const bTime = b ? new Date(b).getTime() : null;
    return aTime === bTime;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
  }
  return (a ?? undefined) === (b ?? undefined);
}

/**
 * @param {object} existingDoc - lean existing Job document
 * @param {object} canonicalJob - freshly normalized job for the same
 *   (source, sourceId)
 * @returns {object} the subset of `canonicalJob` fields that differ
 *   from `existingDoc` (plus `isActive: true` if the doc had been
 *   deactivated and reappeared in this sync)
 */
function diffFields(existingDoc, canonicalJob) {
  const changes = {};
  for (const field of MUTABLE_FIELDS) {
    if (!valuesEqual(existingDoc[field], canonicalJob[field])) {
      changes[field] = canonicalJob[field];
    }
  }
  if (existingDoc.isActive === false) {
    changes.isActive = true;
  }
  return changes;
}

/**
 * Fetches every configured source in parallel. A source throwing (or
 * rejecting) is caught here, logged, and treated as "zero jobs from
 * this source" rather than failing the whole sync.
 *
 * @returns {Promise<{ name: string, key: string, jobs: object[], ok: boolean }[]>}
 */
async function fetchAllSources() {
  const settled = await Promise.allSettled(SOURCES.map((source) => source.fetchJobs()));

  return settled.map((result, index) => {
    const source = SOURCES[index];
    if (result.status === "fulfilled") {
      // eslint-disable-next-line no-console
      console.info(`Fetched ${result.value.length} jobs from ${source.name}`);
      return { name: source.name, key: source.key, jobs: result.value, ok: true };
    }

    // eslint-disable-next-line no-console
    console.error(`[sync] ${source.name} failed, skipping this source for the run:`, result.reason?.message || result.reason);
    return { name: source.name, key: source.key, jobs: [], ok: false };
  });
}

/**
 * Inserts/updates the deduped batch via one bulkWrite call, generating
 * slugs only for genuinely new jobs.
 *
 * @param {object[]} uniqueJobs - deduped canonical jobs
 * @returns {Promise<{ inserted: number, updated: number, skippedDuplicates: number }>}
 */
async function upsertJobs(uniqueJobs) {
  if (uniqueJobs.length === 0) {
    return { inserted: 0, updated: 0, skippedDuplicates: 0 };
  }

  // One bulk lookup instead of one query per job — this is the set of
  // jobs already in the DB that share a (source, sourceId) with
  // something we just fetched, i.e. candidates for "update" rather
  // than "insert".
  const primaryOr = uniqueJobs.map((job) => ({ source: job.source, sourceId: job.sourceId }));
  const existingByPrimary = await Job.find({ $or: primaryOr }).lean();
  const existingPrimaryMap = new Map(existingByPrimary.map((doc) => [buildPrimaryKey(doc), doc]));

  // Secondary-key guard: any OTHER existing job (different source or
  // sourceId) that already occupies this company+title, so we never
  // insert a second document for a job the DB already has under a
  // different provider.
  const existingSecondaryKeys = new Set(
    existingByPrimary.map((doc) => buildSecondaryKey(doc)),
  );
  // Also pull in secondary keys from the wider collection (not just
  // this batch's primary matches) so cross-source duplicates against
  // jobs NOT touched by this sync run are still caught.
  const secondaryOr = uniqueJobs.map((job) => ({
    companyName: job.companyName,
    title: job.title,
  }));
  if (secondaryOr.length) {
    const existingBySecondary = await Job.find({ $or: secondaryOr }, { source: 1, sourceId: 1, companyName: 1, title: 1 }).lean();
    existingBySecondary.forEach((doc) => existingSecondaryKeys.add(buildSecondaryKey(doc)));
  }

  const bulkOps = [];
  let inserted = 0;
  let updated = 0;
  let skippedDuplicates = 0;

  // Slugs claimed so far during THIS run. Jobs being inserted in this
  // batch aren't written to Mongo until the single bulkWrite() at the
  // end, so a DB-only uniqueness check (Job.exists) can't see a slug
  // "claimed" earlier in this same loop -- two new jobs whose title +
  // company slugify to the same base string would otherwise both be
  // handed the same candidate and collide on bulkWrite's unique index.
  // Passing this Set into generateUniqueJobSlug closes that gap.
  const reservedSlugs = new Set();

  for (const job of uniqueJobs) {
    const primaryKey = buildPrimaryKey(job);
    const existingDoc = existingPrimaryMap.get(primaryKey);

    if (existingDoc) {
      // Same (source, sourceId) we already have — update only if
      // something actually changed; never "recreate" an unchanged job.
      const changes = diffFields(existingDoc, job);
      if (Object.keys(changes).length === 0) continue;

      bulkOps.push({
        updateOne: {
          filter: { _id: existingDoc._id },
          update: { $set: changes },
        },
      });
      updated += 1;
      continue;
    }

    // No exact (source, sourceId) match. Before treating this as a new
    // job, check the secondary guard: is this company+title already
    // represented by a *different* existing job?
    const isCrossSourceDuplicate = collidesWithExistingJob(job, existingSecondaryKeys);
    if (isCrossSourceDuplicate) {
      skippedDuplicates += 1;
      continue;
    }

    // Genuinely new job -- needs a slug before it can be inserted.
    // reservedSlugs is threaded through so this also catches collisions
    // against other new jobs earlier in this same batch, not just what's
    // already committed in the DB.
    // eslint-disable-next-line no-await-in-loop
    const slug = await generateUniqueJobSlug(
      { title: job.title, companyName: job.companyName },
      { reservedSlugs },
    );

    bulkOps.push({
      updateOne: {
        filter: { source: job.source, sourceId: job.sourceId },
        update: { $setOnInsert: { ...job, slug, isActive: true } },
        upsert: true,
      },
    });
    // Reserve this key locally so two new jobs in the same batch that
    // happen to share a secondary key (shouldn't happen after
    // dedupeJobs, but cheap insurance) don't both get inserted.
    existingSecondaryKeys.add(buildSecondaryKey(job));
    inserted += 1;
  }

  if (bulkOps.length > 0) {
    await Job.bulkWrite(bulkOps, { ordered: false });
  }

  return { inserted, updated, skippedDuplicates };
}

/**
 * Deactivates jobs belonging to successfully-synced sources that were
 * NOT present in this run's fetch (they've presumably been closed or
 * removed upstream), then permanently deletes jobs that have been
 * inactive for 30+ days.
 *
 * Only sources that returned successfully are considered for
 * deactivation — if a provider's fetch failed outright, its existing
 * jobs are left untouched rather than being wiped out by a transient
 * outage.
 *
 * @param {{ key: string, ok: boolean, jobs: object[] }[]} sourceResults
 * @returns {Promise<{ deactivated: number, deleted: number }>}
 */
async function reconcileExpirations(sourceResults) {
  let deactivated = 0;

  for (const source of sourceResults) {
    if (!source.ok) continue; // don't touch data for a failed provider

    if (source.jobs.length === 0) {
      // A "successful" fetch that returned zero jobs is more likely a
      // transient upstream issue (empty page, provider hiccup) than
      // every single listing closing at once — treat it as suspicious
      // and leave existing jobs for this source alone rather than
      // deactivating all of them.
      // eslint-disable-next-line no-console
      console.warn(`[sync] ${source.name} returned 0 jobs — skipping deactivation for this source as a precaution.`);
      continue;
    }

    const seenSourceIds = source.jobs.map((job) => job.sourceId);
    // eslint-disable-next-line no-await-in-loop
    const result = await Job.updateMany(
      { source: source.key, isActive: true, sourceId: { $nin: seenSourceIds } },
      { $set: { isActive: false } },
    );
    deactivated += result.modifiedCount || 0;
  }

  const cutoff = new Date(Date.now() - INACTIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleteResult = await Job.deleteMany({ isActive: false, updatedAt: { $lt: cutoff } });

  return { deactivated, deleted: deleteResult.deletedCount || 0 };
}

/**
 * Runs one full sync: fetch -> normalize (already done per-source) ->
 * dedupe -> upsert -> expire/delete. Safe to call concurrently-unaware
 * (the scheduler below guards against overlapping runs), and safe to
 * call with zero configured sources reachable — it just does nothing
 * and logs zeros.
 *
 * @returns {Promise<object>} run summary, useful for tests/manual invocation
 */
export async function runSync() {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.info("Starting sync...");

  const sourceResults = await fetchAllSources();
  const allJobs = sourceResults.flatMap((s) => s.jobs);

  const { unique, duplicateCount: inBatchDuplicates } = dedupeJobs(allJobs);

  const { inserted, updated, skippedDuplicates: crossDbDuplicates } = await upsertJobs(unique);
  const { deactivated, deleted } = await reconcileExpirations(sourceResults);

  const skippedDuplicates = inBatchDuplicates + crossDbDuplicates;
  const durationMs = Date.now() - startedAt;

  // eslint-disable-next-line no-console
  console.info(`Inserted ${inserted}`);
  // eslint-disable-next-line no-console
  console.info(`Updated ${updated}`);
  // eslint-disable-next-line no-console
  console.info(`Skipped ${skippedDuplicates} duplicates`);
  // eslint-disable-next-line no-console
  console.info(
    `[sync] Deactivated ${deactivated} job(s) no longer present upstream, permanently deleted ${deleted} job(s) inactive for ${INACTIVE_RETENTION_DAYS}+ days`,
  );
  // eslint-disable-next-line no-console
  console.info(`Finished sync (${durationMs}ms)`);

  return {
    fetched: Object.fromEntries(sourceResults.map((s) => [s.key, s.jobs.length])),
    inserted,
    updated,
    skippedDuplicates,
    deactivated,
    deleted,
    durationMs,
  };
}

let isSyncRunning = false;

/**
 * Wraps runSync() so overlapping triggers (a cron tick landing while a
 * boot-time sync is still running, for example) never run two syncs
 * against the same collection concurrently.
 */
async function runSyncGuarded() {
  if (isSyncRunning) {
    // eslint-disable-next-line no-console
    console.warn("[sync] Skipping trigger — a sync is already in progress.");
    return;
  }
  isSyncRunning = true;
  try {
    await runSync();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[sync] Sync run failed:", error.stack || error.message);
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Starts the recurring sync schedule using node-cron, reading
 * SYNC_INTERVAL_HOURS / SYNC_ON_BOOT from env (see config/env.js).
 * Call once at process startup (see server.js) — this only schedules
 * work, it never blocks startup itself, including the optional
 * immediate boot run.
 *
 * @returns {import("node-cron").ScheduledTask}
 */
export function startSyncScheduler() {
  const intervalHours = Math.max(1, env.syncIntervalHours);
  // node-cron has no native "every N hours" shorthand beyond 0-23, so
  // for intervals under a day we express it as "every Nth hour", and
  // fall back to a fixed daily run for anything larger.
  const cronExpression = intervalHours < 24 ? `0 */${intervalHours} * * *` : "0 0 * * *";

  const task = cron.schedule(cronExpression, () => {
    runSyncGuarded();
  });

  // eslint-disable-next-line no-console
  console.info(`[sync] Scheduler started — running every ${intervalHours}h (cron: "${cronExpression}")`);

  if (env.syncOnBoot) {
    // eslint-disable-next-line no-console
    console.info("[sync] SYNC_ON_BOOT=true — running an initial sync now.");
    runSyncGuarded();
  }

  return task;
}
