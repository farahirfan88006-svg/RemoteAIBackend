import jwt from "jsonwebtoken";
import User from "../models/User.js";

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