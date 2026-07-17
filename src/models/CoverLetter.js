import { Schema, model } from "mongoose";

/**
 * CoverLetter — one document per generated/saved letter. Mirrors the
 * Resume model's ownership pattern (owner ref + per-user CRUD in
 * coverLetters.controller.js) rather than inventing a different access
 * pattern for auth-owned content.
 *
 * `job` is optional and unpopulated by design (stores the couple of
 * fields needed to redisplay "what this letter was tailored to" —
 * jobTitle/companyName/jobSlug — rather than a live ref) — a
 * job-specific letter should keep reading the same even if that job
 * listing later expires or is deactivated (`Job.isActive: false`);
 * re-fetching a possibly-gone Job document to display a past letter
 * would be a real regression for something the user already has saved.
 */
const coverLetterSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, trim: true, default: "Untitled Cover Letter" },
    content: { type: String, default: "" },

    // Present only for job-specific letters (see ticket's "General" vs
    // "Job-Specific" modes) — all optional, all just for display/context.
    job: {
      slug: { type: String, trim: true, default: "" },
      title: { type: String, trim: true, default: "" },
      companyName: { type: String, trim: true, default: "" },
    },
  },
  { timestamps: true },
);

coverLetterSchema.index({ owner: 1, updatedAt: -1 });

export default model("CoverLetter", coverLetterSchema);
