import axios from "axios";
import { env } from "../../config/env.js";
import { normalizeJobRecord } from "../../utils/normalizeJobRecord.js";

/**
 * Wellfound (formerly AngelList Talent) source.
 *
 * IMPORTANT: unlike Greenhouse/Lever/Ashby/Arbeitnow/RemoteOK/Remotive/
 * Himalayas, Wellfound does not publish a free, public, unauthenticated
 * JSON jobs API — its listings are only available through the logged-in
 * site itself or paid third-party scraping services. This project does
 * not scrape Wellfound directly (no login-walled or ToS-restricted
 * scraping), so this source is a pluggable client for a Wellfound job
 * feed you provide yourself (e.g. a licensed data partner or a feed you
 * run), configured via:
 *
 *   WELLFOUND_FEED_URL — a GET endpoint returning a JSON array of jobs
 *   WELLFOUND_API_KEY  — sent as `Authorization: Bearer <key>` if set
 *
 * If WELLFOUND_FEED_URL isn't set, this source is skipped entirely
 * (logged, not thrown) — same "graceful handling if one provider isn't
 * configured" contract as usajobs.source.js. This keeps "Wellfound" a
 * real, wireable source rather than a fabricated/unreliable scraper.
 *
 * Expected job shape is intentionally permissive (several field-name
 * fallbacks) since the exact shape depends on whatever feed you point
 * this at.
 */

export const SOURCE_NAME = "wellfound";

const REQUEST_TIMEOUT_MS = 15000;

/**
 * @returns {Promise<object[]>} canonical jobs. Empty array (with a
 *   warning logged) if WELLFOUND_FEED_URL isn't configured.
 */
export async function fetchJobs() {
  if (!env.wellfoundFeedUrl) {
    // eslint-disable-next-line no-console
    console.warn(
      "[sync:wellfound] Skipping — WELLFOUND_FEED_URL is not set. Wellfound has no free public jobs API; " +
        "point this at a licensed/partner feed if you have one to enable this source.",
    );
    return [];
  }

  const headers = env.wellfoundApiKey ? { Authorization: `Bearer ${env.wellfoundApiKey}` } : undefined;
  const { data } = await axios.get(env.wellfoundFeedUrl, { timeout: REQUEST_TIMEOUT_MS, headers });

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
      category: item.category,
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
