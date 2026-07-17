import { Schema, model } from "mongoose";

/**
 * Job listing.
 *
 * This is the single source of truth the whole Phase 2 read API (jobs,
 * search, categories, companies) is built on top of. Values for
 * `employmentType`, `experienceLevel`, and `remoteType` intentionally match
 * the frontend's filter taxonomy 1:1 (see remoteai/lib/jobs/constants.js on
 * the frontend) so query params can be passed straight through to a Mongo
 * `$in` filter with no translation layer.
 *
 * Phase 2 only defines the schema and read access. Nothing in this phase
 * writes Job documents — ingestion (sync sources, dedupe on
 * `source`+`sourceId`, slug assignment via services/slug.service.js) is
 * Phase 3. The database is expected to be empty until then.
 */

const JOB_TYPE_VALUES = ["full-time", "part-time", "contract", "freelance", "internship"];
const EXPERIENCE_LEVEL_VALUES = ["entry", "mid", "senior", "lead"];
const REMOTE_TYPE_VALUES = ["fully-remote", "hybrid", "region-locked"];

const jobSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    summary: { type: String, trim: true },
    description: { type: String, trim: true },

    companyName: { type: String, required: true, trim: true },
    companyLogo: { type: String, trim: true },
    companyWebsite: { type: String, trim: true },

    location: { type: String, trim: true },
    country: { type: String, trim: true },
    remoteType: { type: String, enum: REMOTE_TYPE_VALUES },
    employmentType: { type: String, enum: JOB_TYPE_VALUES },
    experienceLevel: { type: String, enum: EXPERIENCE_LEVEL_VALUES },

    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    salaryCurrency: { type: String, trim: true, uppercase: true, default: "USD" },

    // Flat string values (not ObjectId refs) on purpose — see Category.js.
    category: { type: String, trim: true, lowercase: true },
    tags: { type: [String], default: [] },

    // Ingestion identity — which sync source this came from and that
    // source's own id for the listing, so re-syncing never creates dupes.
    source: { type: String, required: true, trim: true },
    sourceId: { type: String, required: true, trim: true },
    sourceUrl: { type: String, trim: true },

    // Whether this job's detail page should be indexable by search engines
    // (robots meta / sitemap inclusion on the frontend) — independent of
    // whether it's currently shown in listings, which is `isActive` below.
    indexable: { type: Boolean, default: true },

    datePosted: { type: Date, required: true },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Dedupe target for sync (Phase 3): one job per (source, sourceId).
jobSchema.index({ source: 1, sourceId: 1 }, { unique: true });

// Full-text search across title, company, and tags — backs `q`.
jobSchema.index({ title: "text", companyName: "text", tags: "text" });

// Single-field filter indexes — one per query-able dimension.
jobSchema.index({ category: 1 });
jobSchema.index({ employmentType: 1 });
jobSchema.index({ remoteType: 1 });
jobSchema.index({ experienceLevel: 1 });
jobSchema.index({ datePosted: -1 });

// Not in the original spec list, but added because `isActive: true` is part
// of literally every query this API runs (see jobQuery.service.js) — an
// unindexed field that every filter touches would force a collection scan.
jobSchema.index({ isActive: 1 });

export default model("Job", jobSchema);
