import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import RevokedToken from "../models/RevokedToken.js";

/**
 * Password hashing + JWT issuing/verification, kept separate from
 * auth.controller.js the same way jobQuery.service.js is kept separate
 * from jobs.controller.js elsewhere in this codebase: the controller
 * wires HTTP <-> this logic, and holds none of it itself.
 *
 * Uses `bcryptjs` (pure JS) rather than native `bcrypt` — same hashing
 * algorithm and a drop-in-compatible API, but no native addon/node-gyp
 * build step, which is one less thing that can fail to install across
 * different deploy targets for an app that doesn't otherwise need one.
 */

const SALT_ROUNDS = env.bcryptSaltRounds;

export async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

export async function comparePassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * Signs a JWT for a user. Includes a random `jti` so a specific token
 * can be individually revoked on logout (see models/RevokedToken.js) —
 * without it, the only way to invalidate one token early is to
 * invalidate all of a user's tokens at once.
 */
export function signToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: String(user._id), jti }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
  return token;
}

/** @returns {{ sub: string, jti: string, exp: number, iat: number }} */
export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

/** Records a token's `jti` as revoked until its own natural expiry (see RevokedToken.js's TTL index). */
export async function revokeToken({ jti, exp }) {
  await RevokedToken.updateOne(
    { jti },
    { $setOnInsert: { jti, expiresAt: new Date(exp * 1000) } },
    { upsert: true },
  );
}

export async function isTokenRevoked(jti) {
  return Boolean(await RevokedToken.exists({ jti }));
}
