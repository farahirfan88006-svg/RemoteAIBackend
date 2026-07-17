import { Schema, model } from "mongoose";

/**
 * JWTs are stateless by design — normally "logout" is purely a client
 * action (discard the token) and the server never sees it again. That's
 * fine for a lot of apps, but a `POST /api/auth/logout` that doesn't
 * actually do anything server-side is a common complaint in review, and
 * doesn't meet "secure implementation" well: a token stolen before logout
 * would otherwise stay valid until it naturally expires.
 *
 * This collection is a minimal fix: each JWT gets a random `jti` claim
 * (see auth.service.js#signToken); logging out records that `jti` here
 * until the token's own expiry, and requireAuth.js rejects any token
 * whose `jti` shows up in this collection. A TTL index expires each
 * record automatically at the same time the JWT itself would have
 * expired, so this collection never grows unbounded.
 */
const revokedTokenSchema = new Schema({
  jti: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});

revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model("RevokedToken", revokedTokenSchema);
