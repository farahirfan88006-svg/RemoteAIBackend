/**
 * scripts/backfillTaxonomy.js
 *
 * One-off, manually-run maintenance script. NOT wired into the sync
 * engine, the scheduler, or app startup — nothing calls this
 * automatically, on purpose.
 *
 * Why it exists: category/country normalization (see
 * src/utils/categoryTaxonomy.js and src/utils/countryTaxonomy.js) is
 * applied in src/utils/normalizeJobRecord.js, which only runs when a job
 * is fetched from a source during a sync. Jobs already sitting in
 * MongoDB from before this change keep their old, un-normalized
 * category/country values until the next time their source happens to
 * sync them again (see runSync.js's diff-and-update logic) — which,
 * depending on SYNC_INTERVAL_HOURS, could be hours away.
 *
 * Running this script re-normalizes category/country on every existing
 * Job document immediately, without waiting for a sync cycle, so the
 * new dynamic /api/categories and /api/countries dropdowns are populated
 * as soon as it's run. It's safe to run multiple times (normalization is
 * idempotent) and touches no other field.
 *
 * Usage:
 *   node scripts/backfillTaxonomy.js
 *
 * This intentionally does NOT reuse runSync.js's upsertJobs()/bulkWrite
 * pipeline (that pipeline is for source-driven inserts/updates, keyed on
 * source+sourceId) — this is a simpler, unrelated "update these two
 * fields on every existing doc" pass, run directly against the Job
 * collection via its own bulkWrite call.
 */

import { connectDatabase } from "../src/config/db.js";
import Job from "../src/models/Job.js";
import { normalizeCategory } from "../src/utils/categoryTaxonomy.js";
import { normalizeCountryName } from "../src/utils/countryTaxonomy.js";
import mongoose from "mongoose";

const BATCH_SIZE = 500;

async function run() {
  await connectDatabase();

  const cursor = Job.find({}, { category: 1, country: 1 }).lean().cursor();

  let scanned = 0;
  let changed = 0;
  let batch = [];

  async function flush() {
    if (batch.length === 0) return;
    await Job.bulkWrite(batch, { ordered: false });
    batch = [];
  }

  for await (const doc of cursor) {
    scanned += 1;

    const nextCategory = normalizeCategory(doc.category)?.slug;
    const nextCountry = normalizeCountryName(doc.country);

    const update = {};
    if (nextCategory !== undefined && nextCategory !== doc.category) update.category = nextCategory;
    if (nextCountry !== undefined && nextCountry !== doc.country) update.country = nextCountry;

    if (Object.keys(update).length > 0) {
      changed += 1;
      batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: update } } });
    }

    if (batch.length >= BATCH_SIZE) {
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
  }

  await flush();

  // eslint-disable-next-line no-console
  console.info(`[backfill] Scanned ${scanned} job(s), normalized category/country on ${changed} job(s).`);

  await mongoose.disconnect();
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] Failed:", error.stack || error.message);
  process.exit(1);
});
