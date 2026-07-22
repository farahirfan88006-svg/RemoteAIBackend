import { Schema, model } from "mongoose";

/**
 * Subscription — one document per user, holding the plan that future
 * AI-limit checks (lib/ai/config/limits.js) should key off of.
 *
 * `plan` intentionally matches the PLANS values in
 * lib/ai/config/limits.js ("free" | "premium") — no plan-specific limit
 * numbers live here, only the plan the user is currently on.
 *
 * `expiresAt` is nullable: a free plan (or a premium plan on a
 * non-expiring/manual arrangement) simply has no expiry. When present,
 * it's the point after which `status` should be treated as no longer
 * "active" by whatever service reconciles subscriptions — this model
 * does not itself call any billing provider (no Stripe or other
 * integration here).
 */
const SUBSCRIPTION_PLANS = ["free", "premium"];
const SUBSCRIPTION_STATUSES = ["active", "canceled", "expired", "past_due"];

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    plan: { type: String, enum: SUBSCRIPTION_PLANS, required: true, default: "free" },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: "active" },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One subscription document per user — also the natural lookup path for
// "what plan is this user on".
subscriptionSchema.index({ userId: 1 }, { unique: true });

export const SUBSCRIPTION_PLAN = Object.freeze({
  FREE: "free",
  PREMIUM: "premium",
});

export const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: "active",
  CANCELED: "canceled",
  EXPIRED: "expired",
  PAST_DUE: "past_due",
});

export default model("Subscription", subscriptionSchema);
