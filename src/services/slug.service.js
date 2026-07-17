import slugify from "slugify";
import Job from "../models/Job.js";

/**
 * Generates a unique, SEO-friendly slug for a job, e.g.
 * "senior-backend-engineer-acme-inc" — falling back to "-2", "-3", etc. on
 * collision, so two jobs with the same title+company never collide.
 *
 * Nothing in Phase 2 calls this yet (there's no job-creation endpoint —
 * ingestion is Phase 3), but Job.slug is `required` + `unique`, so this is
 * defined now as the one place that knows how to produce one, ready for
 * the sync layer to import.
 *
 * @param {{ title: string, companyName: string }} job
 * @param {{ excludeId?: string, reservedSlugs?: Set<string> }} [options]
 *   - excludeId: pass the job's own _id when regenerating a slug for an
 *     existing document, so it doesn't collide with itself
 *   - reservedSlugs: an in-memory Set of slugs already claimed during
 *     the current run (e.g. by earlier jobs in the same sync batch
 *     that haven't been written to Mongo yet, so a plain `Job.exists`
 *     check can't see them). When provided, this function checks the
 *     set FIRST (synchronously, no DB round trip) and, once it settles
 *     on a free candidate, adds it to the set before returning — so the
 *     next call in the same batch sees it as taken too. This is what
 *     lets two would-be jobs in one batch that slugify to the same
 *     base string still resolve to "slug" / "slug-2" instead of both
 *     landing on "slug" and blowing up bulkWrite with E11000.
 * @returns {Promise<string>}
 */
export async function generateUniqueJobSlug({ title, companyName }, { excludeId, reservedSlugs } = {}) {
  const base = slugify([title, companyName].filter(Boolean).join(" "), {
    lower: true,
    strict: true,
    trim: true,
  }) || "job";

  let candidate = base;
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const reservedInBatch = reservedSlugs ? reservedSlugs.has(candidate) : false;

    let existsInDb = false;
    if (!reservedInBatch) {
      const query = { slug: candidate };
      if (excludeId) query._id = { $ne: excludeId };

      // eslint-disable-next-line no-await-in-loop
      existsInDb = Boolean(await Job.exists(query));
    }

    if (!reservedInBatch && !existsInDb) {
      if (reservedSlugs) reservedSlugs.add(candidate);
      return candidate;
    }

    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}
