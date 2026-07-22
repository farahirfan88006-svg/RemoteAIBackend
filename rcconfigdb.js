import { apiFetch, ApiError } from "./client";

/**
 * Companies data layer, built on top of `apiFetch` (see lib/api/client.js),
 * backed by the existing `GET /api/companies` endpoint (unmodified —
 * see backend src/controllers/companies.controller.js), which derives its
 * list live from whichever companies currently have active, non-expired
 * jobs and returns `[{ name, slug, logo, jobCount }]`.
 *
 * Same caching rationale as lib/api/taxonomy.js: this only changes as
 * often as the sync engine adds/removes companies, so it's fetched with a
 * longer `revalidate` window than the jobs list itself, and degrades to
 * an empty list (rather than throwing) if the API isn't reachable.
 */

const COMPANIES_ENDPOINT = "/companies";
const COMPANIES_REVALIDATE_SECONDS = 300;

function hasApiBaseUrl() {
  return Boolean(process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL);
}

/**
 * @typedef {object} CompanyOption
 * @property {string} name - exact company name, as stored on Job.companyName
 * @property {string} slug - stable identifier used in /jobs/company/[slug]
 * @property {string|undefined} logo
 * @property {number} count - number of currently active jobs at this company
 */

/** @returns {CompanyOption|null} */
function normalizeCompanyEntry(entry) {
  const name = entry?.name;
  const slug = entry?.slug;
  const count = Number(entry?.jobCount ?? entry?.count);
  if (!name || !slug) return null;
  return {
    name: String(name),
    slug: String(slug),
    logo: entry?.logo || undefined,
    count: Number.isFinite(count) ? count : 0,
  };
}

/** @returns {Promise<CompanyOption[]>} companies that currently have active jobs, sorted by job count desc */
export async function getCompanies() {
  if (!hasApiBaseUrl()) return [];

  try {
    const data = await apiFetch(COMPANIES_ENDPOINT, {
      init: { next: { revalidate: COMPANIES_REVALIDATE_SECONDS } },
    });
    const rows = Array.isArray(data) ? data : [];
    return rows.map(normalizeCompanyEntry).filter(Boolean);
  } catch (error) {
    if (error instanceof ApiError) return [];
    throw error;
  }
}

/**
 * Finds one company by its URL slug from an already-fetched list — avoids
 * a second network request when the caller already loaded the full list
 * (see app/jobs/company/[slug]/page.js).
 *
 * @param {CompanyOption[]} companies
 * @param {string} slug
 * @returns {CompanyOption|undefined}
 */
export function findCompanyBySlug(companies, slug) {
  return companies.find((company) => company.slug === slug);
}
