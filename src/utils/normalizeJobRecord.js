/**
 * normalizeJobRecord.js
 *
 * The single place that turns a source-specific "raw" job (already
 * roughly shaped by its source file, e.g. src/sync/sources/greenhouse.source.js)
 * into one identical canonical Job object every downstream consumer
 * (dedupe.service.js, runSync.js, Job model) can rely on.
 *
 * This does NOT touch MongoDB and does NOT assign a slug — slug
 * generation is deliberately left to runSync.js, which is the only place
 * that knows whether a job is new (needs a slug) or already exists
 * (keeps its slug). This module is a pure function: raw in, canonical
 * out (or null if the record is too incomplete to be a real job, OR if
 * it's not an English-language listing — see languageDetect.js).
 *
 * Because every source file already only pushes a job when this
 * function returns a truthy value (see each src/sync/sources/*.js), this
 * is also the single enforcement point for "English jobs only": every
 * current and future source is filtered here, with no per-source changes
 * needed.
 *
 * Canonical fields (matches src/models/Job.js exactly, minus slug):
 *   title, summary, description, companyName, companyLogo,
 *   companyWebsite, location, country, remoteType, employmentType,
 *   experienceLevel, salaryMin, salaryMax, salaryCurrency, category,
 *   tags, source, sourceId, sourceUrl, datePosted, expiresAt
 */

import { isEnglishText } from "./languageDetect.js";
import { normalizeCategory } from "./categoryTaxonomy.js";
import { normalizeCountryName } from "./countryTaxonomy.js";


const JOB_TYPE_VALUES = new Set(["full-time", "part-time", "contract", "freelance", "internship"]);
const EXPERIENCE_LEVEL_VALUES = new Set(["entry", "mid", "senior", "lead"]);
const REMOTE_TYPE_VALUES = new Set(["fully-remote", "hybrid", "region-locked"]);

// A listing with no explicit expiry is treated as open for this long from
// its posting date — matches typical job-board listing lifetimes. This is
// only ever a fallback; sources that report a real close date (USAJobs'
// ApplicationCloseDate, for example) always win.
const DEFAULT_LISTING_LIFETIME_DAYS = 60;

const SUMMARY_MAX_LENGTH = 280;

function stripHtml(value) {
  if (!value) return "";
  return String(value)
    // Remove script/style blocks entirely (content and tags) — never
    // surface executable content pulled from a third-party API.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips <script>/<style> content out of HTML we're about to store as
 * `description`, without otherwise touching markup. We keep description
 * as (lightly sanitized) HTML because the frontend renders it as such;
 * `summary` is always plain text.
 */
function sanitizeDescriptionHtml(value) {
  if (!value) return undefined;
  const cleaned = String(value).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  return cleaned.trim() || undefined;
}

function buildSummary(explicitSummary, description) {
  const source = explicitSummary && String(explicitSummary).trim() ? explicitSummary : description;
  const plain = stripHtml(source);
  if (!plain) return undefined;
  if (plain.length <= SUMMARY_MAX_LENGTH) return plain;
  return `${plain.slice(0, SUMMARY_MAX_LENGTH).trim()}…`;
}

function toTrimmedString(value) {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

function toEnumValue(value, allowedSet) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return allowedSet.has(normalized) ? normalized : undefined;
}

function toNumberOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function toDateOrUndefined(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    const clean = toTrimmedString(tag)?.toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

/**
 * Infers remoteType from free-text location/title when a source doesn't
 * give us a structured value. Best-effort only — never overrides an
 * already-known remoteType.
 */
function inferRemoteType(rawRemoteType, location, title) {
  const direct = toEnumValue(rawRemoteType, REMOTE_TYPE_VALUES);
  if (direct) return direct;

  const haystack = `${location || ""} ${title || ""}`.toLowerCase();
  if (/\bhybrid\b/.test(haystack)) return "hybrid";
  if (/\b(fully remote|100% remote|remote[- ]first|remote)\b/.test(haystack)) return "fully-remote";
  return undefined;
}

/**
 * @param {object} raw - source-specific job shape. Required: title,
 *   companyName, source, sourceId. Everything else is optional and will
 *   be coerced, clamped, or defaulted.
 * @returns {object|null} canonical Job-shaped object, or null if `raw`
 *   is missing a required field, or is not English-language, and can't
 *   safely become a Job document.
 */
export function normalizeJobRecord(raw = {}) {
  const title = toTrimmedString(raw.title);
  const companyName = toTrimmedString(raw.companyName);
  const source = toTrimmedString(raw.source);
  const sourceId = toTrimmedString(raw.sourceId);

  // These four are `required` on the Job model — without them there is
  // nothing safe to upsert, so the caller should skip this record.
  if (!title || !companyName || !source || !sourceId) {
    return null;
  }

  const description = sanitizeDescriptionHtml(raw.description);
  const summary = buildSummary(raw.summary, raw.description);

  // English-only: reject titles/descriptions that are primarily German,
  // French, Spanish, Italian, Dutch, Portuguese, or written in a
  // non-Latin script (Russian, Chinese, Japanese, Korean, Arabic, ...).
  // Checked against title + summary (summary is already plain text, so
  // this doesn't need its own HTML stripping) — see languageDetect.js
  // for the detection heuristic itself.
  if (!isEnglishText(`${title} ${summary || ""}`)) {
    return null;
  }

  let salaryMin = toNumberOrUndefined(raw.salaryMin);
  let salaryMax = toNumberOrUndefined(raw.salaryMax);
  if (salaryMin !== undefined && salaryMax !== undefined && salaryMin > salaryMax) {
    [salaryMin, salaryMax] = [salaryMax, salaryMin];
  }

  const datePosted = toDateOrUndefined(raw.datePosted) || new Date();
  const expiresAt =
    toDateOrUndefined(raw.expiresAt) ||
    new Date(datePosted.getTime() + DEFAULT_LISTING_LIFETIME_DAYS * 24 * 60 * 60 * 1000);

  const location = toTrimmedString(raw.location);

  return {
    title,
    summary,
    description,

    companyName,
    companyLogo: toTrimmedString(raw.companyLogo),
    companyWebsite: toTrimmedString(raw.companyWebsite),

    location,
    // Normalized to a consistent canonical name (e.g. "usa"/"US" -> "United
    // States", "Remote"/"Global" -> "Worldwide") so the countries facet
    // never fragments into near-duplicate values — see countryTaxonomy.js.
    country: normalizeCountryName(raw.country),
    remoteType: inferRemoteType(raw.remoteType, location, title),
    employmentType: toEnumValue(raw.employmentType, JOB_TYPE_VALUES),
    experienceLevel: toEnumValue(raw.experienceLevel, EXPERIENCE_LEVEL_VALUES),

    salaryMin,
    salaryMax,
    salaryCurrency: (toTrimmedString(raw.salaryCurrency) || "USD").toUpperCase(),

    // Normalized to one of ~45 curated canonical categories (stored as its
    // slug, matching the pre-existing lowercase-slug convention for this
    // field) so wildly different provider department labels collapse into
    // one meaningful taxonomy — see categoryTaxonomy.js.
    category: normalizeCategory(raw.category)?.slug,
    tags: normalizeTags(raw.tags),

    source: source.toLowerCase(),
    sourceId,
    sourceUrl: toTrimmedString(raw.sourceUrl),

    datePosted,
    expiresAt,
  };
}

export const JOB_TYPE_ENUM = JOB_TYPE_VALUES;
export const EXPERIENCE_LEVEL_ENUM = EXPERIENCE_LEVEL_VALUES;
export const REMOTE_TYPE_ENUM = REMOTE_TYPE_VALUES;
