import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";
import { GREENHOUSE_COMPANIES } from "../companies.config.js";

/**
 * Greenhouse source — pulls live listings from Greenhouse's public Job
 * Board API (no auth required), one company at a time:
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * https://developers.greenhouse.io/job-board.html
 */

export const SOURCE_NAME = "greenhouse";

const BASE_URL = "https://boards-api.greenhouse.io/v1/boards";
const REQUEST_TIMEOUT_MS = 15000;

function mapEmploymentType(metadata = []) {
  const entry = metadata.find((m) => /employment type|job type/i.test(m?.name || ""));
  const value = String(entry?.value || "").toLowerCase();
  if (value.includes("part")) return "part-time";
  if (value.includes("contract")) return "contract";
  if (value.includes("freelance")) return "freelance";
  if (value.includes("intern")) return "internship";
  if (value.includes("full")) return "full-time";
  return undefined;
}

/**
 * Fetches every open listing for one Greenhouse board token and maps it
 * to the raw shape normalizeJobRecord.js expects.
 *
 * @param {{ token: string, companyName: string, companyWebsite?: string }} company
 * @returns {Promise<object[]>}
 */
async function fetchCompanyJobs(company) {
  const url = `${BASE_URL}/${encodeURIComponent(company.token)}/jobs?content=true`;
  const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });

  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) =>
    normalizeJobRecord({
      title: job.title,
      description: job.content,
      companyName: company.companyName,
      companyWebsite: company.companyWebsite,
      location: job.location?.name,
      category: job.departments?.[0]?.name,
      employmentType: mapEmploymentType(job.metadata),
      source: SOURCE_NAME,
      sourceId: String(job.id),
      sourceUrl: job.absolute_url,
      datePosted: job.updated_at || job.first_published,
    }),
  );
}

/**
 * Fetches jobs for every configured Greenhouse company. One company
 * failing (dead board token, network error, etc.) is logged and
 * skipped — it never aborts the other companies or the source as a
 * whole, per the "graceful handling if one provider fails" requirement.
 *
 * @returns {Promise<object[]>} canonical jobs (nulls from
 *   normalizeJobRecord already filtered out)
 */
export async function fetchJobs() {
  const results = await Promise.allSettled(GREENHOUSE_COMPANIES.map((company) => fetchCompanyJobs(company)));

  const jobs = [];
  results.forEach((result, index) => {
    const company = GREENHOUSE_COMPANIES[index];
    if (result.status === "fulfilled") {
      jobs.push(...result.value.filter(Boolean));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[sync:greenhouse] Skipping "${company.companyName}" (${company.token}): ${result.reason?.message || result.reason}`,
      );
    }
  });

  return jobs;
}
