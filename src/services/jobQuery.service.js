import Job from "../models/Job.js";
import { parsePagination, buildPaginationMeta } from "../utils/pagination.js";
import { CATEGORY_TAXONOMY_LIST } from "../utils/categoryTaxonomy.js";
import { normalizeCountry } from "../utils/countryTaxonomy.js";
import { normalizeTagEntry } from "../utils/tagTaxonomy.js";

/**
 * Builds Mongo queries for the Job collection from raw query-string params.
 *
 * This is the ONLY place in the codebase that turns `req.query` into a
 * Mongo filter/sort. `jobs.controller.js` and `search.controller.js` both
 * call `searchJobs()` below and return its result as-is — neither one
 * re-implements filtering, so the two endpoints can never drift apart.
 * `categories.controller.js` and `companies.controller.js` reuse
 * `buildJobFilter()` for the same reason (so "what counts as a visible
 * job" is defined once).
 */

/** Maps a frontend query param name to the Job field it filters on. */
const MULTI_VALUE_FIELDS = {
  category: "category",
  type: "employmentType",
  experience: "experienceLevel",
  remoteType: "remoteType",
  // Added for dynamic country filtering (Categories/Countries dropdown
  // feature) — additive, existing params above are untouched.
  country: "country",
  // Added for the /jobs/company/[slug] SEO landing page — additive.
  // Job has no stable `companySlug` field (slug support wasn't added to
  // the model per the "do not modify models" constraint), so this matches
  // the exact `companyName` string. The frontend resolves a URL slug to
  // its exact company name via /api/companies (see lib/api/companies.js)
  // before ever sending a `company` query param here — same pattern as
  // the country dropdown resolving a slug back to its canonical name.
  company: "companyName",
  // Added for the programmatic SEO skill pages (/remote-python-jobs,
  // /remote-react-jobs, ...) — additive. Matches the exact (already
  // lowercase, already deduped — see normalizeJobRecord.js) tag string,
  // same "frontend resolves slug -> canonical value before querying"
  // pattern as `company` above (see /api/tags + lib/api/tags.js).
  skill: "tags",
};

const SORTS = {
  newest: { datePosted: -1 },
  oldest: { datePosted: 1 },
  "salary-desc": { salaryMax: -1, salaryMin: -1, datePosted: -1 },
  "salary-asc": { salaryMin: 1, salaryMax: 1, datePosted: -1 },
};

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the Mongo filter for the jobs collection from raw query params.
 *
 * `exclude` skips one dimension's own constraint. This is used when
 * computing facet counts for that same dimension (see `getCategoryFacets`
 * / `getLocationFacets`) — e.g. the category facet should reflect "how
 * many jobs per category match every *other* active filter", not be
 * narrowed by whichever category is already selected.
 *
 * @param {object} query - raw req.query (q, category, type, experience,
 *   remoteType, location, salaryMin, salaryMax)
 * @param {{ exclude?: string[] }} [options]
 * @returns {object} Mongo filter
 */
export function buildJobFilter(query = {}, { exclude = [] } = {}) {
  const filter = { isActive: true };
  const skip = (key) => exclude.includes(key);

  if (!skip("q") && query.q && String(query.q).trim()) {
    filter.$text = { $search: String(query.q).trim() };
  }

  Object.entries(MULTI_VALUE_FIELDS).forEach(([param, field]) => {
    if (skip(param)) return;
    const values = toArray(query[param]);
    if (values.length) filter[field] = { $in: values };
  });

  if (!skip("location") && query.location && String(query.location).trim()) {
    filter.location = { $regex: escapeRegex(String(query.location).trim()), $options: "i" };
  }

  if (!skip("salary")) {
    if (query.salaryMin !== undefined && query.salaryMin !== "") {
      const salaryMin = Number(query.salaryMin);
      if (Number.isFinite(salaryMin)) filter.salaryMax = { $gte: salaryMin };
    }
    if (query.salaryMax !== undefined && query.salaryMax !== "") {
      const salaryMax = Number(query.salaryMax);
      if (Number.isFinite(salaryMax)) filter.salaryMin = { $lte: salaryMax };
    }
  }

  // Only ever surface jobs that haven't expired (or have no expiry set).
  filter.$or = [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gte: new Date() } }];

  return filter;
}

/**
 * @param {object} query - raw req.query
 * @returns {{ sort: object, usesTextScore: boolean }}
 */
function resolveSort(query = {}) {
  if (query.sort === "relevance" && query.q) {
    return { sort: { score: { $meta: "textScore" } }, usesTextScore: true };
  }
  return { sort: SORTS[query.sort] || SORTS.newest, usesTextScore: false };
}

/**
 * Adapts a lean Job document into the shape the frontend's data layer
 * expects (see remoteai/lib/jobs/normalizeJob.js and
 * remoteai/lib/seo/schemas.js on the frontend, which read these exact
 * field names).
 *
 * @param {object} doc - lean Mongo document
 */
export function serializeJob(doc) {
  return {
    id: String(doc._id),
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary || undefined,
    description: doc.description || undefined,
    companyName: doc.companyName,
    companyLogo: doc.companyLogo || undefined,
    companyWebsite: doc.companyWebsite || undefined,
    location: doc.location || undefined,
    country: doc.country || undefined,
    remoteType: doc.remoteType || undefined,
    employmentType: doc.employmentType || undefined,
    experienceLevel: doc.experienceLevel || undefined,
    salaryMin: doc.salaryMin ?? undefined,
    salaryMax: doc.salaryMax ?? undefined,
    salaryCurrency: doc.salaryCurrency || undefined,
    category: doc.category || undefined,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    sourceUrl: doc.sourceUrl || undefined,
    datePosted: doc.datePosted ? doc.datePosted.toISOString() : undefined,
    // Added: previously omitted, even though the frontend job detail page
    // already reads `job.indexable` for its robots meta (see
    // remoteai/app/jobs/[slug]/page.js) and app/sitemap.js needs
    // `updatedAt` for each job URL's `lastModified` — both were silently
    // always `undefined` on every response before this change.
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : undefined,
    indexable: doc.indexable !== false,
  };
}

function humanizeSlug(value) {
  return String(value)
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Shared aggregation for both `getCategoryFacets` and `getLocationFacets`:
 * counts distinct values of one Job field, under the filter every other
 * active param produces (see `exclude` above).
 */
async function facetCounts(query, { excludeParam, field, limit, formatLabel }) {
  const filter = buildJobFilter(query, { exclude: [excludeParam] });

  const rows = await Job.aggregate([
    { $match: filter },
    { $match: { [field]: { $nin: [null, ""] } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => ({ value: row._id, label: formatLabel(row._id), count: row.count }));
}

/**
 * Category facet counts. Powers both the `facets.categories` field on
 * `/api/jobs` and the standalone `/api/categories` endpoint (called there
 * with an empty query, i.e. unfiltered global counts) — categories are
 * never hardcoded, they're always whatever currently exists on Job
 * documents.
 *
 * @param {object} query
 * @param {number} [limit]
 */
export function getCategoryFacets(query = {}, limit = 50) {
  return facetCounts(query, { excludeParam: "category", field: "category", limit, formatLabel: humanizeSlug });
}

/**
 * Location facet counts, powering `facets.locations` on `/api/jobs`.
 * Location values are already human-readable free text (not slugs), so
 * unlike categories they're used as their own label.
 *
 * @param {object} query
 * @param {number} [limit]
 */
export function getLocationFacets(query = {}, limit = 50) {
  return facetCounts(query, { excludeParam: "location", field: "location", limit, formatLabel: (value) => value });
}

// slug -> canonical display name, e.g. "data-and-ai" -> "Data & AI". Built
// once from the curated taxonomy so dedicated-endpoint labels always match
// the exact canonical name (humanizeSlug alone can't reconstruct "&", so it
// isn't reused here).
const CATEGORY_NAME_BY_SLUG = new Map(CATEGORY_TAXONOMY_LIST.map((entry) => [entry.slug, entry.name]));
CATEGORY_NAME_BY_SLUG.set("other", "Other");

/**
 * Distinct, normalized categories that currently have at least one active,
 * non-expired job — i.e. what powers a "select a category from real data"
 * dropdown. Unlike `getCategoryFacets` (which returns Phase 2's
 * `{ value, label, count }` shape for `/api/jobs`'s `facets.categories`,
 * left untouched so that response contract never changes), this returns
 * `{ name, slug, count }` per the dynamic-filters spec, sorted by count
 * descending, with empty/duplicate values already impossible since
 * `category` is written from a bounded, deduped taxonomy at ingestion
 * time (see utils/categoryTaxonomy.js).
 *
 * @param {number} [limit]
 * @returns {Promise<{ name: string, slug: string, count: number }[]>}
 */
export async function getCategoryTaxonomyFacets(limit = 100) {
  const filter = { ...buildJobFilter({}), category: { $nin: [null, ""] } };

  const rows = await Job.aggregate([
    { $match: filter },
    { $group: { _id: "$category", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => ({
    name: CATEGORY_NAME_BY_SLUG.get(row._id) || humanizeSlug(row._id),
    slug: row._id,
    count: row.count,
  }));
}

/**
 * Distinct, normalized countries that currently have at least one active,
 * non-expired job — powers a "select a country from real data" dropdown.
 * `country` is already written as a consistent canonical name at
 * ingestion time (see utils/countryTaxonomy.js), so this aggregation only
 * needs to group and count, not fuzzy-merge anything itself.
 *
 * @param {number} [limit]
 * @returns {Promise<{ name: string, slug: string, count: number }[]>}
 */
export async function getCountryTaxonomyFacets(limit = 200) {
  const filter = { ...buildJobFilter({}), country: { $nin: [null, ""] } };

  const rows = await Job.aggregate([
    { $match: filter },
    { $group: { _id: "$country", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => {
    const normalized = normalizeCountry(row._id) || { name: row._id, slug: row._id };
    return { name: normalized.name, slug: normalized.slug, count: row.count };
  });
}

/**
 * Distinct, normalized tags/skills that currently have at least one
 * active, non-expired job — powers `/api/tags` and, from there, the
 * dynamically generated skill SEO landing pages (/remote-python-jobs,
 * /remote-react-jobs, ...). `tags` is an array field, so this unwinds it
 * before grouping — unlike `category`/`country` (single-value fields),
 * one job can contribute to several tag counts here.
 *
 * @param {number} [limit]
 * @returns {Promise<{ name: string, slug: string, count: number }[]>}
 */
export async function getTagTaxonomyFacets(limit = 200) {
  const filter = buildJobFilter({});

  const rows = await Job.aggregate([
    { $match: filter },
    { $unwind: "$tags" },
    { $match: { tags: { $nin: [null, ""] } } },
    { $group: { _id: "$tags", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows
    .map((row) => {
      const normalized = normalizeTagEntry(row._id);
      return normalized ? { name: normalized.name, slug: normalized.slug, count: row.count } : null;
    })
    .filter(Boolean);
}

/**
 * Runs a full jobs query — filter, sort, pagination, and facets — and
 * returns exactly the response shape the frontend expects from both
 * `GET /api/jobs` and `GET /api/search`:
 *
 *   { jobs, total, page, pageSize, totalPages, facets: { categories, locations } }
 *
 * @param {object} query - raw req.query
 */
export async function searchJobs(query = {}) {
  const { page, pageSize } = parsePagination(query);
  const filter = buildJobFilter(query);
  const { sort, usesTextScore } = resolveSort(query);
  const skip = (page - 1) * pageSize;

  const findQuery = usesTextScore
    ? Job.find(filter, { score: { $meta: "textScore" } })
    : Job.find(filter);

  const [docs, total, categories, locations] = await Promise.all([
    findQuery.sort(sort).skip(skip).limit(pageSize).lean(),
    Job.countDocuments(filter),
    getCategoryFacets(query),
    getLocationFacets(query),
  ]);

  const { totalPages } = buildPaginationMeta({ total, page, pageSize });

  return {
    jobs: docs.map(serializeJob),
    total,
    page,
    pageSize,
    totalPages,
    facets: { categories, locations },
  };
}

/**
 * Fetches one job by its slug, for the job detail page
 * (GET /api/jobs/:slug — see routes/jobs.routes.js). Only returns active
 * jobs — an inactive job behaves the same as a nonexistent one here,
 * consistent with every other read in this service (`buildJobFilter`
 * always applies `isActive: true` unless explicitly excluded).
 *
 * @param {string} slug
 * @returns {Promise<object|null>} serialized job, or null if not found/inactive
 */
export async function getJobBySlug(slug) {
  const doc = await Job.findOne({ slug, isActive: true }).lean();
  return doc ? serializeJob(doc) : null;
}
