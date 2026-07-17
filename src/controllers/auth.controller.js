import User from "../models/User.js";
import {
  hashPassword,
  comparePassword,
  signToken,
  revokeToken,
} from "../services/auth.service.js";
import {
  isValidEmail,
  isValidPassword,
  passwordRequirementsMessage,
  isNonEmptyString,
} from "../utils/validators.js";
import { badRequest, unauthorized, conflict } from "../utils/AppError.js";

/**
 * POST /api/auth/register
 * Body: { email, password, name? }
 */
export async function register(req, res, next) {
  try {
    const { email, password, name } = req.body || {};

    if (!isValidEmail(email)) throw badRequest("A valid email is required.", "INVALID_EMAIL");
    if (!isValidPassword(password)) {
      throw badRequest(passwordRequirementsMessage(), "INVALID_PASSWORD");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await User.exists({ email: normalizedEmail });
    if (existing) throw conflict("An account with this email already exists.", "EMAIL_TAKEN");

    const passwordHash = await hashPassword(password);
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      name: isNonEmptyString(name) ? name.trim() : "",
    });

    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !isNonEmptyString(password)) {
      throw badRequest("Email and password are required.", "INVALID_CREDENTIALS");
    }

    const normalizedEmail = email.trim().toLowerCase();
    // passwordHash is `select: false` on the schema — must opt back in explicitly here.
    const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");

    // Deliberately the same error for "no such user" and "wrong password"
    // — distinguishing them lets an attacker enumerate valid emails.
    if (!user || !(await comparePassword(password, user.passwordHash))) {
      throw unauthorized("Invalid email or password.", "INVALID_CREDENTIALS");
    }

    const token = signToken(user);
    user.passwordHash = undefined; // belt-and-suspenders on top of toJSON's transform
    res.json({ token, user });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/logout
 * Requires auth. Revokes the current token's jti (see
 * services/auth.service.js#revokeToken) — see models/RevokedToken.js for
 * why this is more than a client-side no-op.
 */
export async function logout(req, res, next) {
  try {
    await revokeToken(req.tokenClaims);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/me
 * Requires auth.
 */
export async function getMe(req, res) {
  res.json({ user: req.user });
}

/**
 * PUT /api/auth/me
 * Requires auth. Body: { name? }
 * Deliberately doesn't allow changing `email` here — email changes
 * commonly need their own re-verification flow, which is out of scope;
 * see "Known limitations" in the final summary.
 */
export async function updateMe(req, res, next) {
  try {
    const { name } = req.body || {};
    if (name !== undefined) {
      if (!isNonEmptyString(name)) throw badRequest("Name cannot be empty.", "INVALID_NAME");
      req.user.name = name.trim();
    }
    await req.user.save();
    res.json({ user: req.user });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/auth/change-password
 * Requires auth. Body: { currentPassword, newPassword }
 */
export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!isNonEmptyString(currentPassword) || !isValidPassword(newPassword)) {
      throw badRequest(passwordRequirementsMessage(), "INVALID_PASSWORD");
    }

    // req.user came from requireAuth without passwordHash selected — reload it with it.
    const userWithHash = await User.findById(req.user._id).select("+passwordHash");
    if (!(await comparePassword(currentPassword, userWithHash.passwordHash))) {
      throw unauthorized("Current password is incorrect.", "INVALID_CREDENTIALS");
    }

    userWithHash.passwordHash = await hashPassword(newPassword);
    await userWithHash.save();
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
