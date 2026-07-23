import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { isTokenRevoked } from "../services/auth.service.js";

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please log in and try again.",
        errors: ["MISSING_OR_INVALID_AUTH_HEADER"],
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.tokenClaims = decoded;
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: "Your session is invalid or has expired. Please log in again.",
        errors: ["INVALID_OR_EXPIRED_TOKEN"],
      });
    }

    // FIX (stabilization pass): isTokenRevoked() already existed in
    // auth.service.js (backed by the RevokedToken model, populated on
    // logout) but was never actually called anywhere — meaning logout
    // never invalidated a token; it stayed valid until natural expiry.
    // This restores that check.
    if (decoded.jti && (await isTokenRevoked(decoded.jti))) {
      return res.status(401).json({
        success: false,
        message: "Your session has been logged out. Please log in again.",
        errors: ["TOKEN_REVOKED"],
      });
    }

    const userId =
      decoded.sub ||
      decoded.id ||
      decoded.userId ||
      decoded._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload.",
        errors: ["INVALID_TOKEN_PAYLOAD"],
      });
    }

    const user = await User.findById(userId).select("-passwordHash");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found.",
        errors: ["USER_NOT_FOUND"],
      });
    }

    req.user = user;

    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Something went wrong while verifying your session.",
      errors: [err.message],
    });
  }
}

export default requireAuth;