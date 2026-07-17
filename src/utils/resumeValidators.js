import { isValidEmail, isValidUrl, isValidDateString } from "./validators.js";
import { RESUME_TEMPLATES } from "../models/Resume.js";
import { badRequest } from "./AppError.js";

/**
 * Validates an incoming resume create/update payload.
 *
 * Deliberately format-only, not required-ness — Resume Builder
 * auto-saves drafts (see ticket: "Save drafts automatically"), which
 * means a half-filled-out resume is the normal, expected state, not an
 * error. What IS validated: any field that's actually present and
 * non-empty has to be well-formed (a provided email must look like an
 * email, a provided URL must be a real URL, a provided date must parse).
 * An empty string/omitted field always passes — that's just "not filled
 * in yet".
 *
 * Throws a 400 AppError with the first problem found (fail on the first
 * error rather than accumulating a list — matches how the rest of this
 * codebase's validation reads, e.g. auth.controller.js).
 */
export function validateResumePayload(body) {
  if (body.template !== undefined && !RESUME_TEMPLATES.includes(body.template)) {
    throw badRequest(`template must be one of: ${RESUME_TEMPLATES.join(", ")}`, "INVALID_TEMPLATE");
  }

  const email = body.personalInfo?.email;
  if (email && !isValidEmail(email)) {
    throw badRequest("personalInfo.email must be a valid email address.", "INVALID_EMAIL");
  }

  const urlFields = [
    ["socialLinks.linkedin", body.socialLinks?.linkedin],
    ["socialLinks.github", body.socialLinks?.github],
    ["socialLinks.portfolio", body.socialLinks?.portfolio],
    ["socialLinks.website", body.socialLinks?.website],
  ];
  for (const [label, value] of urlFields) {
    if (value && !isValidUrl(value)) {
      throw badRequest(`${label} must be a valid URL (starting with http:// or https://).`, "INVALID_URL");
    }
  }

  for (const project of body.projects || []) {
    if (project.url && !isValidUrl(project.url)) {
      throw badRequest("Each project URL must be a valid URL.", "INVALID_URL");
    }
  }
  for (const cert of body.certifications || []) {
    if (cert.url && !isValidUrl(cert.url)) {
      throw badRequest("Each certification URL must be a valid URL.", "INVALID_URL");
    }
  }

  const dateRangeSections = ["experience", "education", "volunteerExperience"];
  for (const section of dateRangeSections) {
    for (const entry of body[section] || []) {
      if (entry.startDate && !isValidDateString(entry.startDate)) {
        throw badRequest(`${section}.startDate must be a valid date (YYYY, YYYY-MM, or YYYY-MM-DD).`, "INVALID_DATE");
      }
      if (entry.endDate && !entry.current && !isValidDateString(entry.endDate)) {
        throw badRequest(`${section}.endDate must be a valid date (YYYY, YYYY-MM, or YYYY-MM-DD).`, "INVALID_DATE");
      }
    }
  }

  for (const ref of body.references || []) {
    if (ref.email && !isValidEmail(ref.email)) {
      throw badRequest("Each reference email must be a valid email address.", "INVALID_EMAIL");
    }
  }
}

/**
 * Fields a client is allowed to write, whitelisted explicitly rather
 * than trusting the whole request body — prevents e.g. `owner` or `_id`
 * being overwritten by a crafted payload.
 */
export const WRITABLE_RESUME_FIELDS = [
  "title",
  "template",
  "personalInfo",
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "languages",
  "awards",
  "volunteerExperience",
  "interests",
  "references",
  "socialLinks",
  "sectionOrder",
];

export function pickWritableFields(body) {
  const result = {};
  for (const field of WRITABLE_RESUME_FIELDS) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  return result;
}
