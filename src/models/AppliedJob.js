import { Schema, model } from "mongoose";

/**
 * AppliedJob — one document per (user, job) application. Same
 * owner + job-ref + jobSnapshot shape as SavedJob.js (see that file's
 * comment for why the snapshot exists), plus the fields specific to
 * tracking an application: `status` and `appliedDate`.
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

// Order matters for the Dashboard's "pipeline" reading of an
// application's progress — not enforced anywhere, just the natural
// order these are presented in throughout the UI.
export const APPLICATION_STATUS_VALUES = ["applied", "interview", "assessment", "offer", "rejected"];

const appliedJobSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    jobSnapshot: { type: jobSnapshotSchema, default: () => ({}) },

    status: { type: String, enum: APPLICATION_STATUS_VALUES, default: "applied" },

    // Defaults to "now" (the moment the user marks a job Applied), but
    // stays editable in case someone logs an application after the
    // fact and wants the real date on record.
    appliedDate: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Dedupe target: one application record per (user, job) — updating
// status/date happens via PUT, not by creating a second record (see
// spec's "Prevent duplicate records" requirement).
appliedJobSchema.index({ owner: 1, job: 1 }, { unique: true });

// Powers the Applied Jobs list's default ordering and the Dashboard's
// per-status counts.
appliedJobSchema.index({ owner: 1, createdAt: -1 });
appliedJobSchema.index({ owner: 1, status: 1 });

export default model("AppliedJob", appliedJobSchema);
