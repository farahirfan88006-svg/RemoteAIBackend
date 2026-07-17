import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * RemoteOK source — pulls live listings from RemoteOK's public JSON API
 * (no auth required). Like Arbeitnow, this is a multi-company aggregator
 * of remote-only jobs, so there's no companies.config.js entry — one
 * request returns jobs from many employers directly.
 *
 *   GET https://remoteok.com/api
 *
 * The first element of the response array is always a legal-notice
 * object (no `id`/`position` fields), not a job — it's skipped.
 */

export const SOURCE_NAME = "remoteok";

const BASE_URL = "https://remoteok.com/api";
const REQUEST_TIMEOUT_MS = 15000;

/**
 * @returns {Promise<object[]>} canonical jobs (nulls from
 *   normalizeJobRecord — including non-English listings — already
 *   filtered out).
 */
export async function fetchJobs() {
  const { data } = await axios.get(BASE_URL, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      // RemoteOK blocks requests with no/blank User-Agent.
      "User-Agent": "RemoteAI-Sync/1.0 (+https://remoteai.example.com)",
    },
  });

  const items = Array.isArray(data) ? data : [];
  const jobs = [];

  for (const item of items) {
    // Skip the legal-notice header entry and any malformed rows.
    if (!item || !item.id || !item.position) continue;

    const normalized = normalizeJobRecord({
      title: item.position,
      description: item.description,
      companyName: item.company,
      companyLogo: item.company_logo || item.logo,
      companyWebsite: item.company_url,
      location: item.location,
      remoteType: "fully-remote",
      salaryMin: item.salary_min,
      salaryMax: item.salary_max,
      tags: item.tags,
      category: Array.isArray(item.tags) ? item.tags[0] : undefined,
      source: SOURCE_NAME,
      sourceId: String(item.id),
      sourceUrl: item.url || (item.slug ? `https://remoteok.com/remote-jobs/${item.slug}` : undefined),
      datePosted: item.date,
    });
    if (normalized) jobs.push(normalized);
  }

  return jobs;
}
