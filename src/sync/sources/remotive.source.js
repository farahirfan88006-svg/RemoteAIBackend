import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * Remotive source — pulls live listings from Remotive's public Remote
 * Jobs API (no auth required). Another multi-company remote-only
 * aggregator, same shape as Arbeitnow/RemoteOK — no companies.config.js
 * entry needed.
 *
 *   GET https://remotive.com/api/remote-jobs
 *
 * https://github.com/remotive-com/remote-jobs-api
 */

export const SOURCE_NAME = "remotive";

const BASE_URL = "https://remotive.com/api/remote-jobs";
const REQUEST_TIMEOUT_MS = 15000;

function mapEmploymentType(jobType) {
  const value = String(jobType || "").toLowerCase();
  if (value.includes("part")) return "part-time";
  if (value.includes("contract")) return "contract";
  if (value.includes("freelance")) return "freelance";
  if (value.includes("intern")) return "internship";
  if (value.includes("full")) return "full-time";
  return undefined;
}

/**
 * @returns {Promise<object[]>} canonical jobs (nulls from
 *   normalizeJobRecord — including non-English listings — already
 *   filtered out).
 */
export async function fetchJobs() {
  const { data } = await axios.get(BASE_URL, { timeout: REQUEST_TIMEOUT_MS });

  const items = Array.isArray(data?.jobs) ? data.jobs : [];
  const jobs = [];

  for (const item of items) {
    const normalized = normalizeJobRecord({
      title: item.title,
      description: item.description,
      companyName: item.company_name,
      companyLogo: item.company_logo,
      location: item.candidate_required_location,
      remoteType: "fully-remote",
      employmentType: mapEmploymentType(item.job_type),
      category: item.category,
      source: SOURCE_NAME,
      sourceId: String(item.id),
      sourceUrl: item.url,
      datePosted: item.publication_date,
    });
    if (normalized) jobs.push(normalized);
  }

  return jobs;
}
