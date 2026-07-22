import { Schema, model } from "mongoose";

/**
 * SavedAIResult — one document per AI output a user has explicitly kept,
 * separate from AIHistory. AIHistory is an automatic, complete call log;
 * SavedAIResult is a small user-curated subset ("save this one") with a
 * user-editable `title`, the same "save this content under a title"
 * pattern CoverLetter already uses for owned content.
 *
 * `metadata` is intentionally a free-form Mixed bag rather than a fixed
 * set of fields, since what's worth recording differs per feature (e.g.
 * a saved salary estimate might want { role, location, currency } while
 * a saved cover letter might want { jobTitle, companyName }) — the same
 * "optional, display-only context" role CoverLetter.job plays.
 */
const savedAIResultSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    feature: { type: String, required: true, trim: true },

    title: { type: String, trim: true, default: "Untitled" },
    content: { type: Schema.Types.Mixed, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// Powers "this user's saved results for this feature" and "this user's
// saved results overall", most recently updated first.
savedAIResultSchema.index({ userId: 1, feature: 1, updatedAt: -1 });
savedAIResultSchema.index({ userId: 1, updatedAt: -1 });

export default model("SavedAIResult", savedAIResultSchema);
