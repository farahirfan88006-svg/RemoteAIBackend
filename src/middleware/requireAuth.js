/**
 * src/middleware/requireAuth.js
 * ---------------------------------------------------------------------------
 * Verifies the caller is authenticated, attaches the user document to
 * `req.user`, and returns consistent JSON error responses otherwise.
 *
 * ASSUMPTIONS (adjust the marked lines if your existing auth flow differs):
 *  - Token is sent as `Authorization: Bearer <token>`.
 *  - Token is signed with `process.env.JWT_SECRET` (jsonwebtoken is already
 *    a project dependency).
 *  - Token payload contains the user id as `id`, `userId`, or `_id`.
 *  - `src/models/User.js` exports a Mongoose model as its default export.
 * ---------------------------------------------------------------------------
 */

import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export default async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in and try again.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: ['MISSING_OR_INVALID_AUTH_HEADER'],
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: 'Your session is invalid or has expired. Please log in again.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: ['INVALID_OR_EXPIRED_TOKEN'],
      });
    }

    const userId = decoded.id || decoded.userId || decoded._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Your session is invalid or has expired. Please log in again.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: ['INVALID_TOKEN_PAYLOAD'],
      });
    }

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'We could not find an account for this session. Please log in again.',
        plan: null,
        usageRemaining: null,
        data: null,
        errors: ['USER_NOT_FOUND'],
      });
    }

    req.user = user;
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while verifying your session.',
      plan: null,
      usageRemaining: null,
      data: null,
      errors: [err.message || 'AUTH_INTERNAL_ERROR'],
    });
  }
}

// FIX NOTE (stabilization pass): src/routes/auth.routes.js imports this as
// a named export (`import { requireAuth } from ...`), while every AI route
// under src/routes/ai/*.routes.js imports the default export
// (`import requireAuth from ...`). Only having a default export meant
// auth.routes.js threw a SyntaxError on import ("does not provide an
// export named 'requireAuth'"), which — since app.js statically imports
// auth.routes.js — broke the entire app from loading, not just the AI
// routes. Adding this named re-export satisfies both call sites without
// changing either one.
export { requireAuth };
