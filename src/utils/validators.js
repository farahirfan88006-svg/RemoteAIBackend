/**
 * Small, dependency-free validators shared by auth.controller.js and
 * resumes.controller.js. Kept intentionally simple (no Joi/Zod/express
 * validator added) — the existing project has zero validation libraries
 * as a dependency, and this project's own convention (see
 * services/jobQuery.service.js) favors small hand-written helpers over
 * a new dependency for something this contained.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// At least 8 characters, at least one letter and one number — a
// reasonable, common baseline without being needlessly restrictive.
const PASSWORD_MIN_LENGTH = 8;

export function isValidEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

export function isValidPassword(value) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH) return false;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

export function passwordRequirementsMessage() {
  return `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include at least one letter and one number.`;
}

export function isValidUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Accepts "YYYY-MM-DD", "YYYY-MM", or "YYYY" — resume date fields are often month-precision only. */
export function isValidDateString(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value.trim())) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
