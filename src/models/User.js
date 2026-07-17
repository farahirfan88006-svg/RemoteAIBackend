import { Schema, model } from "mongoose";

/**
 * User — the account behind everything auth-gated (currently: Resume
 * Builder and the Resume Analyzer). This is the first authenticated
 * entity in the codebase; every other model so far (Job, Category,
 * Company) is public, read-only data with no owner.
 *
 * `passwordHash` is deliberately named (not `password`) so it's obvious
 * at every call site that it's already hashed, and is excluded from
 * `toJSON` (see `transform` below) so a raw `res.json(user)` can never
 * accidentally leak it — the same "never leak internals" instinct
 * middleware/errorHandler.js already applies to error messages.
 */
const userSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export default model("User", userSchema);
