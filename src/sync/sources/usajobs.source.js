import axios from "axios";
import { env } from "../../config/env.js";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * USAJobs source — pulls live U.S. federal government listings from the
 * official USAJobs Search API. Unlike the other sources this one
 * requires credentials (a free registration, not a paid key):
 *
 *   GET https://data.usajobs.gov/api/search
 *   Headers: Host: data.usajobs.gov
 *            User-Agent: <the email you registered with>
 *            Authorization-Key: <your API key>
 *
 * https://developer.usajobs.gov/api-reference/get-api-search
 *
 * If USAJOBS_API_KEY / USAJOBS_USER_AGENT aren't set, this source is
 * skipped entirely (logged, not thrown) — per the "graceful handling if
 * one provider fails" requirement, missing credentials for one provider
 * must never stop the rest of the sync.
 */

export const SOURCE_NAME = "usajobs";

const BASE_URL = "https://data.usajobs.gov/api/search";
const REQUEST_TIMEOUT_MS = 20000;
const RESULTS_PER_PAGE = 250;
// Hard ceiling on pages per sync run, same rationale as Arbeitnow.
const MAX_PAGES = 8;

function mapEmploymentType(descriptor) {
  const scheduleName = descriptor.PositionSchedule?.[0]?.Name || "";
  const offeringName = descriptor.PositionOfferingType?.[0]?.Name || "";
  const haystack = `${scheduleName} ${offeringName}`.toLowerCase();

  if (haystack.includes("part")) return "part-time";
  if (haystack.includes("intern") || haystack.includes("student")) return "internship";
  if (haystack.includes("temporary") || haystack.includes("term")) return "contract";
  if (haystack.includes("full")) return "full-time";
  return undefined;
}

function mapRemoteType(descriptor) {
  const teleworkEligible = descriptor.UserArea?.Details?.TeleworkEligible;
  if (teleworkEligible === true || teleworkEligible === "true") return "hybrid";
  return "region-locked";
}

/**
 * @returns {Promise<object[]>} canonical jobs. Empty array (with a
 *   warning logged) if credentials are missing.
 */
export async function fetchJobs() {
  if (!env.usajobsApiKey || !env.usajobsUserAgent) {
    // eslint-disable-next-line no-console
    console.warn(
      "[sync:usajobs] Skipping — USAJOBS_API_KEY and/or USAJOBS_USER_AGENT is not set. " +
        "Register free at https://developer.usajobs.gov/ to enable this source.",
    );
    return [];
  }

  const headers = {
    Host: "data.usajobs.gov",
    "User-Agent": env.usajobsUserAgent,
    "Authorization-Key": env.usajobsApiKey,
  };

  const jobs = [];
  let page = 1;
  let totalPages = 1;

  do {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(BASE_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      headers,
      params: { ResultsPerPage: RESULTS_PER_PAGE, Page: page, WhoMayApply: "public" },
    });

    const items = data?.SearchResult?.SearchResultItems || [];
    const paginationCount = Number(data?.SearchResult?.SearchResultCountAll) || 0;
    totalPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(paginationCount / RESULTS_PER_PAGE)));

    for (const item of items) {
      const descriptor = item.MatchedObjectDescriptor || {};
      const remuneration = descriptor.PositionRemuneration?.[0] || {};

      const normalized = normalizeJobRecord({
        title: descriptor.PositionTitle,
        description: descriptor.UserArea?.Details?.JobSummary || descriptor.QualificationSummary,
        summary: descriptor.QualificationSummary,
        companyName: descriptor.OrganizationName || descriptor.DepartmentName,
        location: descriptor.PositionLocationDisplay,
        country: "United States",
        remoteType: mapRemoteType(descriptor),
        employmentType: mapEmploymentType(descriptor),
        salaryMin: remuneration.MinimumRange,
        salaryMax: remuneration.MaximumRange,
        salaryCurrency: "USD",
        category: descriptor.JobCategory?.[0]?.Name,
        source: SOURCE_NAME,
        sourceId: item.MatchedObjectId,
        sourceUrl: descriptor.PositionURI,
        datePosted: descriptor.PublicationStartDate,
        expiresAt: descriptor.ApplicationCloseDate,
      });
      if (normalized) jobs.push(normalized);
    }

    page += 1;
  } while (page <= totalPages);

  return jobs;
}
