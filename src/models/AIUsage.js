import { Schema, model } from "mongoose";

/**
 * AIUsage — one document per (user, feature, period), tracking how many
 * times that user has called that AI feature in the current period.
 *
 * This is deliberately just a counter, not a log: `lib/ai/config/limits.js`
 * is the only place plan quotas live (no limit numbers are hardcoded
 * here), and `AIHistory` is the place individual calls are recorded in
 * detail. A future usage-tracking service is expected to:
 *   1. Read the feature's limit + period from lib/ai/config/limits.js.
 *   2. Upsert this document (by userId+feature+currentPeriod), bumping
 *      usageCount and lastUsedAt.
 *   3. Compare usageCount against the configured limit before allowing
 *      the call through.
 *
 * `currentPeriod` is a plain string (e.g. "2026-07" for a monthly
 * period) rather than a Date range, so "am I still in the same period
 * as this document" is a cheap string comparison instead of a date-math
 * check on every request.
 */
const aiUsageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    feature: { type: String, required: true, trim: true },

    usageCount: { type: Number, required: true, default: 0, min: 0 },

    // Identifies the period this counter applies to (e.g. "2026-07" for
    // monthly, "2026-07-22" for daily) — format is owned by whatever
    // service resets/upserts this document, not by the model.
    currentPeriod: { type: String, required: true, trim: true },

    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One usage counter per user+feature+period — also the natural lookup
// path for "how many times has this user used this feature this period".
aiUsageSchema.index({ userId: 1, feature: 1, currentPeriod: 1 }, { unique: true });

export default model("AIUsage", aiUsageSchema);
