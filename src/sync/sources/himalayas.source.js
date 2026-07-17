import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * Himalayas source — pulls live listings from Himalayas' public Remote
 * Jobs API (no auth required). Multi-company aggregator, same shape as
 * Arbeitnow/RemoteOK/Remotive — no companies.config.js entry needed.
 *
 *   GET https://himalayas.app/jobs/api?offset={n}&limit=20
 *
 * https://himalayas.app/docs/remote-jobs-api
 *
 * The browse endpoint pages in fixed chunks of up to 20 jobs, reporting
 * `totalCount` so we know when to stop. Himalayas notes the underlying
 * data only refreshes once every 24h, so there's no benefit to fetching
 * more aggressively than one sync run needs.
 */

export const SOURCE_NAME = "himalayas";

const BASE_URL = "https://himalayas.app/jobs/api";
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_SIZE = 20;
// Hard ceiling on pages so a bad `totalCount` can't turn one sync run
// into an unbounded loop (same rationale as Arbeitnow/USAJobs).
const MAX_PAGES = 25;

function mapEmploymentType(employmentType) {
  const value = String(employmentType || "").toLowerCase();
  if (value.includes("part")) return "part-time";
  if (value.includes("contractor") || value.includes("temporary")) return "contract";
  if (value.includes("intern")) return "internship";
  if (value.includes("full")) return "full-time";
  return undefined;
}

function mapRemoteType(locationRestrictions) {
  // Himalayas only lists remote-friendly roles; a non-empty restriction
  // list means candidates must be based in specific countries, which we
  // model as "region-locked" rather than fully open.
  return Array.isArray(locationRestrictions) && locationRestrictions.length > 0 ? "region-locked" : "fully-remote";
}

/**
 * @returns {Promise<object[]>} canonical jobs across every page
 *   Himalayas reports (up to MAX_PAGES).
 */
export async function fetchJobs() {
  const jobs = [];
  let offset = 0;
  let totalCount = Infinity;
  let page = 0;

  while (offset < totalCount && page < MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(BASE_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      params: { offset, limit: PAGE_SIZE },
    });

    const items = Array.isArray(data?.jobs) ? data.jobs : [];
    totalCount = Number(data?.totalCount) || items.length;

    for (const item of items) {
      const normalized = normalizeJobRecord({
        title: item.title,
        description: item.description || item.excerpt,
        summary: item.excerpt,
        companyName: item.companyName,
        companyLogo: item.companyLogo,
        location: Array.isArray(item.locationRestrictions) && item.locationRestrictions.length === 1
          ? item.locationRestrictions[0]
          : undefined,
        country: Array.isArray(item.locationRestrictions) && item.locationRestrictions.length === 1
          ? item.locationRestrictions[0]
          : undefined,
        remoteType: mapRemoteType(item.locationRestrictions),
        employmentType: mapEmploymentType(item.employmentType),
        salaryMin: item.minSalary,
        salaryMax: item.maxSalary,
        category: Array.isArray(item.categories) ? item.categories[0] : undefined,
        tags: item.categories,
        source: SOURCE_NAME,
        sourceId: String(item.guid || item.id || `${item.companySlug}-${item.title}`),
        sourceUrl:
          item.url ||
          item.applyUrl ||
          (item.companySlug ? `https://himalayas.app/companies/${item.companySlug}` : undefined),
        datePosted: item.postedAt,
      });
      if (normalized) jobs.push(normalized);
    }

    offset += PAGE_SIZE;
    page += 1;

    // Nothing left to fetch (short page) — stop even if totalCount says
    // otherwise, rather than looping on an empty response.
    if (items.length === 0) break;
  }

  return jobs;
}
