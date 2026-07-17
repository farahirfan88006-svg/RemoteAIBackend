import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";
import { ASHBY_COMPANIES } from "../companies.config.js";

/**
 * Ashby source — pulls live listings from Ashby's public Job Board API
 * (no auth required), one company at a time:
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{token}
 *
 * https://developers.ashbyhq.com/reference/jobpostingsync
 */

export const SOURCE_NAME = "ashby";

const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";
const REQUEST_TIMEOUT_MS = 15000;

function mapEmploymentType(employmentType) {
  const value = String(employmentType || "").toLowerCase();
  if (value.includes("part")) return "part-time";
  if (value.includes("contract")) return "contract";
  if (value.includes("freelance")) return "freelance";
  if (value.includes("intern")) return "internship";
  if (value.includes("full")) return "full-time";
  return undefined;
}

/**
 * @param {{ token: string, companyName: string, companyWebsite?: string }} company
 * @returns {Promise<object[]>}
 */
async function fetchCompanyJobs(company) {
  const url = `${BASE_URL}/${encodeURIComponent(company.token)}`;
  const { data } = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    params: { includeCompensation: true },
  });

  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) =>
    normalizeJobRecord({
      title: job.title,
      description: job.descriptionHtml || job.descriptionPlain,
      companyName: company.companyName,
      companyWebsite: company.companyWebsite,
      location: job.location,
      country: job.address?.postalAddress?.addressCountry,
      category: job.department || job.team,
      employmentType: mapEmploymentType(job.employmentType),
      remoteType: job.isRemote ? "fully-remote" : undefined,
      source: SOURCE_NAME,
      sourceId: String(job.id),
      sourceUrl: job.jobUrl || job.applyUrl,
      datePosted: job.publishedAt || job.updatedAt,
    }),
  );
}

/**
 * @returns {Promise<object[]>} canonical jobs across every configured
 *   Ashby company, skipping any company whose fetch fails.
 */
export async function fetchJobs() {
  const results = await Promise.allSettled(ASHBY_COMPANIES.map((company) => fetchCompanyJobs(company)));

  const jobs = [];
  results.forEach((result, index) => {
    const company = ASHBY_COMPANIES[index];
    if (result.status === "fulfilled") {
      jobs.push(...result.value.filter(Boolean));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[sync:ashby] Skipping "${company.companyName}" (${company.token}): ${result.reason?.message || result.reason}`,
      );
    }
  });

  return jobs;
}
