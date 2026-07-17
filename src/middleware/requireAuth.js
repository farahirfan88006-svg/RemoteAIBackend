import User from "../models/User.js";
import { verifyToken, isTokenRevoked } from "../services/auth.service.js";
import { unauthorized } from "../utils/AppError.js";

/**
 * Protects any route it's applied to (see routes/resumes.routes.js,
 * routes/analyzer.routes.js, and the profile routes in auth.routes.js).
 *
 * Expects `Authorization: Bearer <token>`. On success, attaches:
 *   req.user       - the full Mongoose User document (no passwordHash —
 *                    that field is `select: false` on the schema, and
 *                    was never requested here)
 *   req.tokenClaims - the decoded JWT payload (sub/jti/exp), in case a
 *                    handler needs the raw claims (logout uses this)
 *
 * Every failure path (missing header, malformed token, expired, revoked,
 * user no longer exists) converges on the same generic 401 — this
 * deliberately doesn't distinguish "expired" from "invalid" etc. in the
 * response, so a client can't use error-message differences to probe for
 * valid-but-expired vs. entirely-fake tokens.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw unauthorized();
    }

    let claims;
    try {
      claims = verifyToken(token);
    } catch {
      throw unauthorized();
    }

    if (await isTokenRevoked(claims.jti)) {
      throw unauthorized();
    }

    const user = await User.findById(claims.sub);
    if (!user) {
      throw unauthorized();
    }

    req.user = user;
    req.tokenClaims = claims;
    next();
  } catch (error) {
    next(error);
  }
}
