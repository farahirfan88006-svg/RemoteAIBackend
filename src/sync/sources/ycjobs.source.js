import axios from "axios";
import { env } from "../../config/env.js";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * YC Jobs (Y Combinator's "Work at a Startup", workatastartup.com) source.
 *
 * IMPORTANT: same situation as wellfound.source.js — Work at a Startup
 * does not publish a free, public, unauthenticated JSON jobs API; its
 * listings live behind the logged-in site. This project does not scrape
 * it directly, so this source is a pluggable client for a YC jobs feed
 * you provide yourself, configured via:
 *
 *   YCJOBS_FEED_URL — a GET endpoint returning a JSON array of jobs
 *   YCJOBS_API_KEY  — sent as `Authorization: Bearer <key>` if set
 *
 * If YCJOBS_FEED_URL isn't set, this source is skipped entirely (logged,
 * not thrown) — same graceful-skip contract as usajobs.source.js and
 * wellfound.source.js.
 */

export const SOURCE_NAME = "ycjobs";

const REQUEST_TIMEOUT_MS = 15000;

/**
 * @returns {Promise<object[]>} canonical jobs. Empty array (with a
 *   warning logged) if YCJOBS_FEED_URL isn't configured.
 */
export async function fetchJobs() {
  if (!env.ycjobsFeedUrl) {
    // eslint-disable-next-line no-console
    console.warn(
      "[sync:ycjobs] Skipping — YCJOBS_FEED_URL is not set. Work at a Startup has no free public jobs API; " +
        "point this at a licensed/partner feed if you have one to enable this source.",
    );
    return [];
  }

  const headers = env.ycjobsApiKey ? { Authorization: `Bearer ${env.ycjobsApiKey}` } : undefined;
  const { data } = await axios.get(env.ycjobsFeedUrl, { timeout: REQUEST_TIMEOUT_MS, headers });

  const items = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  const jobs = [];

  for (const item of items) {
    const normalized = normalizeJobRecord({
      title: item.title || item.position,
      description: item.description,
      companyName: item.companyName || item.company_name || item.company,
      companyLogo: item.companyLogo || item.company_logo,
      companyWebsite: item.companyWebsite || item.company_website,
      location: item.location,
      remoteType: item.remote || item.isRemote ? "fully-remote" : undefined,
      employmentType: item.employmentType || item.jobType,
      salaryMin: item.salaryMin || item.salary_min,
      salaryMax: item.salaryMax || item.salary_max,
      category: item.category || item.role,
      tags: item.tags,
      source: SOURCE_NAME,
      sourceId: String(item.id || item.jobId || item.slug),
      sourceUrl: item.url || item.applyUrl,
      datePosted: item.datePosted || item.postedAt || item.createdAt,
    });
    if (normalized) jobs.push(normalized);
  }

  return jobs;
}
