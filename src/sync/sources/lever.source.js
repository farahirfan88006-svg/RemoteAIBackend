import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";
import { LEVER_COMPANIES } from "../companies.config.js";

/**
 * Lever source — pulls live listings from Lever's public Postings API
 * (no auth required), one company at a time:
 *
 *   GET https://api.lever.co/v0/postings/{token}?mode=json
 *
 * https://github.com/lever/postings-api
 */

export const SOURCE_NAME = "lever";

const BASE_URL = "https://api.lever.co/v0/postings";
const REQUEST_TIMEOUT_MS = 15000;

function mapEmploymentType(commitment) {
  const value = String(commitment || "").toLowerCase();
  if (value.includes("part")) return "part-time";
  if (value.includes("contract") || value.includes("temp")) return "contract";
  if (value.includes("freelance")) return "freelance";
  if (value.includes("intern")) return "internship";
  if (value.includes("full")) return "full-time";
  return undefined;
}

function mapRemoteType(workplaceType) {
  const value = String(workplaceType || "").toLowerCase();
  if (value.includes("remote")) return "fully-remote";
  if (value.includes("hybrid")) return "hybrid";
  if (value.includes("on-site") || value.includes("onsite")) return "region-locked";
  return undefined;
}

/**
 * @param {{ token: string, companyName: string, companyWebsite?: string }} company
 * @returns {Promise<object[]>}
 */
async function fetchCompanyJobs(company) {
  const url = `${BASE_URL}/${encodeURIComponent(company.token)}?mode=json`;
  const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });

  const postings = Array.isArray(data) ? data : [];

  return postings.map((posting) =>
    normalizeJobRecord({
      title: posting.text,
      description: posting.descriptionPlain || posting.description,
      companyName: company.companyName,
      companyWebsite: company.companyWebsite,
      location: posting.categories?.location,
      category: posting.categories?.team,
      employmentType: mapEmploymentType(posting.categories?.commitment),
      remoteType: mapRemoteType(posting.workplaceType),
      tags: posting.tags,
      source: SOURCE_NAME,
      sourceId: String(posting.id),
      sourceUrl: posting.hostedUrl || posting.applyUrl,
      datePosted: posting.createdAt ? new Date(Number(posting.createdAt)) : undefined,
    }),
  );
}

/**
 * @returns {Promise<object[]>} canonical jobs across every configured
 *   Lever company, skipping any company whose fetch fails.
 */
export async function fetchJobs() {
  const results = await Promise.allSettled(LEVER_COMPANIES.map((company) => fetchCompanyJobs(company)));

  const jobs = [];
  results.forEach((result, index) => {
    const company = LEVER_COMPANIES[index];
    if (result.status === "fulfilled") {
      jobs.push(...result.value.filter(Boolean));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[sync:lever] Skipping "${company.companyName}" (${company.token}): ${result.reason?.message || result.reason}`,
      );
    }
  });

  return jobs;
}
