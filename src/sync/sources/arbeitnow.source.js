import axios from "axios";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * Arbeitnow source — pulls live listings from Arbeitnow's public Job
 * Board API (no auth required). Unlike Greenhouse/Lever/Ashby this is a
 * multi-company aggregator, not a per-company board, so there's no
 * companies.config.js entry for it — one paginated query returns jobs
 * from many employers directly.
 *
 *   GET https://www.arbeitnow.com/api/job-board-api
 *
 * https://documenter.getpostman.com/view/9605314/2s93JusNJt
 */

export const SOURCE_NAME = "arbeitnow";

const BASE_URL = "https://www.arbeitnow.com/api/job-board-api";
const REQUEST_TIMEOUT_MS = 15000;

// Hard ceiling on pages so a misbehaving/never-ending `next` link can't
// turn one sync run into an unbounded loop.
const MAX_PAGES = 10;

function mapEmploymentType(jobTypes = []) {
  const haystack = jobTypes.map((t) => String(t).toLowerCase()).join(" ");
  if (haystack.includes("part")) return "part-time";
  if (haystack.includes("contract")) return "contract";
  if (haystack.includes("freelance")) return "freelance";
  if (haystack.includes("intern")) return "internship";
  if (haystack.includes("full")) return "full-time";
  return undefined;
}

/**
 * @returns {Promise<object[]>} canonical jobs across every page
 *   Arbeitnow returns (up to MAX_PAGES).
 */
export async function fetchJobs() {
  const jobs = [];
  let url = BASE_URL;
  let page = 0;

  while (url && page < MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
    const items = Array.isArray(data?.data) ? data.data : [];

    for (const item of items) {
      const normalized = normalizeJobRecord({
        title: item.title,
        description: item.description,
        companyName: item.company_name,
        location: item.location,
        remoteType: item.remote ? "fully-remote" : undefined,
        employmentType: mapEmploymentType(item.job_types),
        tags: item.tags,
        category: item.tags?.[0],
        source: SOURCE_NAME,
        sourceId: item.slug,
        sourceUrl: item.url,
        datePosted: item.created_at ? new Date(Number(item.created_at) * 1000) : undefined,
      });
      if (normalized) jobs.push(normalized);
    }

    url = data?.links?.next || null;
    page += 1;
  }

  return jobs;
}
