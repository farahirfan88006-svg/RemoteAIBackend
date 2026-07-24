import { Schema, model } from "mongoose";

/**
 * SavedJob — one document per (user, job) bookmark. Mirrors the
 * CoverLetter model's "own the job snapshot, don't rely on a live ref"
 * pattern: `jobSnapshot` carries the couple dozen display fields the
 * frontend's JobCard/normalizeJob already know how to render, captured
 * at save time. A saved job should keep reading the same even if the
 * underlying Job listing later expires or is deactivated
 * (`Job.isActive: false`) or removed by a sync run — re-fetching a
 * possibly-gone Job document to display something the user explicitly
 * bookmarked would be a real regression.
 *
 * `job` is still kept as a real ref (not just the snapshot) so
 * duplicate-prevention and "is this job saved" lookups can key off a
 * stable ObjectId rather than a snapshot's mutable fields.
 */

const jobSnapshotSchema = new Schema(
  {
    slug: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, default: "" },
    companyName: { type: String, trim: true, default: "" },
    companyLogo: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    remoteType: { type: String, trim: true, default: "" },
    employmentType: { type: String, trim: true, default: "" },
    experienceLevel: { type: String, trim: true, default: "" },
    salaryMin: { type: Number },
    salaryMax: { type: Number },
    salaryCurrency: { type: String, trim: true, default: "" },
    category: { type: String, trim: true, default: "" },
    tags: { type: [String], default: [] },
    sourceUrl: { type: String, trim: true, default: "" },
    datePosted: { type: Date },
  },
  { _id: false },
);

const savedJobSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    jobSnapshot: { type: jobSnapshotSchema, default: () => ({}) },
  },
  { timestamps: true },
);

// Dedupe target: a user can only save a given job once (see spec's
// "Prevent duplicate saved jobs" requirement) — enforced at the DB
// level, not just in controller logic.
savedJobSchema.index({ owner: 1, job: 1 }, { unique: true });

// Powers the Saved Jobs page's default "most recently saved first" list.
savedJobSchema.index({ owner: 1, createdAt: -1 });

export default model("SavedJob", savedJobSchema);
