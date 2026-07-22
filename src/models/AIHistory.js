import { Schema, model } from "mongoose";

/**
 * AIHistory — one document per AI feature call, regardless of outcome.
 * This is the detailed log that AIUsage's counters are aggregated from;
 * AIUsage answers "how many", AIHistory answers "what happened, when,
 * with what input/output, via which provider".
 *
 * `provider` records which entry from lib/ai/providers/index.js handled
 * the call (e.g. "free", "openai", "gemini") purely for
 * traceability/debugging — this model has no opinion on which provider
 * is active and does not call any provider itself.
 *
 * `status` covers the request lifecycle so a call can be recorded even
 * before/without a successful output (e.g. rate-limited or errored).
 */
const AI_HISTORY_STATUSES = ["pending", "success", "error"];

const aiHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    feature: { type: String, required: true, trim: true },

    input: { type: Schema.Types.Mixed, default: null },
    output: { type: Schema.Types.Mixed, default: null },

    provider: { type: String, trim: true, default: "" },
    status: { type: String, enum: AI_HISTORY_STATUSES, default: "pending" },
  },
  { timestamps: true },
);

// Powers "this user's history for this feature, most recent first" and
// "this user's full AI history, most recent first".
aiHistorySchema.index({ userId: 1, feature: 1, createdAt: -1 });
aiHistorySchema.index({ userId: 1, createdAt: -1 });

export const AI_HISTORY_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCESS: "success",
  ERROR: "error",
});

export default model("AIHistory", aiHistorySchema);
