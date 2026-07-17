/**
 * dedupe.service.js
 *
 * Deduplication rules for sync (Phase 3):
 *   - Primary key: `source` + `sourceId` — the same listing re-fetched
 *     from the same provider must always resolve to the same key.
 *   - Secondary protection: `companyName` + `title` (case-insensitive) —
 *     catches the same real-world job appearing under two different
 *     (source, sourceId) pairs, e.g. a company that posts to both
 *     Greenhouse and Lever, or a provider that changes a listing's id
 *     when it's edited.
 *
 * This module only reasons about in-memory batches of already-normalized
 * canonical jobs (see utils/normalizeJobRecord.js) plus a set of keys
 * that already exist in MongoDB — it never queries the database itself,
 * so it stays trivially unit-testable and runSync.js stays the only
 * place that talks to Mongo.
 */

/**
 * @param {{ source: string, sourceId: string }} job
 */
export function buildPrimaryKey(job) {
  return `${String(job.source).toLowerCase()}::${String(job.sourceId)}`;
}

/**
 * @param {{ companyName: string, title: string }} job
 */
export function buildSecondaryKey(job) {
  const company = String(job.companyName || "").trim().toLowerCase();
  const title = String(job.title || "").trim().toLowerCase();
  return `${company}::${title}`;
}

/**
 * Deduplicates a batch of canonical jobs against itself.
 *
 * Given the union of jobs fetched from every source in one sync run,
 * returns only the jobs that are unique by primary key, and within
 * that, unique by secondary key — the first occurrence of a given
 * (company, title) pair wins and every later one is reported as a
 * duplicate, regardless of which source it came from.
 *
 * @param {object[]} jobs - canonical jobs (see normalizeJobRecord.js)
 * @returns {{ unique: object[], duplicateCount: number }}
 */
export function dedupeJobs(jobs) {
  const seenPrimary = new Set();
  const seenSecondary = new Set();
  const unique = [];
  let duplicateCount = 0;

  for (const job of jobs) {
    const primaryKey = buildPrimaryKey(job);
    const secondaryKey = buildSecondaryKey(job);

    if (seenPrimary.has(primaryKey) || seenSecondary.has(secondaryKey)) {
      duplicateCount += 1;
      continue;
    }

    seenPrimary.add(primaryKey);
    seenSecondary.add(secondaryKey);
    unique.push(job);
  }

  return { unique, duplicateCount };
}

/**
 * Checks a single canonical job against sets of keys already known to
 * exist in MongoDB (built by runSync.js from a bulk `Job.find` before
 * the write phase, so this stays a synchronous, allocation-free check
 * per job rather than one query per job).
 *
 * @param {object} job - canonical job
 * @param {Set<string>} existingSecondaryKeys - secondary keys of
 *   existing DB jobs whose primary key did NOT match this job (i.e.
 *   candidates for "same job, different source")
 * @returns {boolean} true if this job collides with a different
 *   existing job by company+title and should be skipped as a duplicate
 *   rather than inserted
 */
export function collidesWithExistingJob(job, existingSecondaryKeys) {
  return existingSecondaryKeys.has(buildSecondaryKey(job));
}
