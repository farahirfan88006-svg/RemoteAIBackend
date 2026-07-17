/**
 * companies.config.js
 *
 * Which companies to pull from each per-company ATS API
 * (Greenhouse / Lever / Ashby all publish one public jobs feed per
 * company, keyed by a "board token" that's usually just the company's
 * slug on that platform). Arbeitnow and USAJobs are aggregators with no
 * per-company config — they're queried directly by their own source
 * files.
 *
 * This file holds identifiers only (which company to ask a real API
 * about) — never job data itself. Every job returned by
 * src/sync/sources/*.js comes from a live HTTP call to the provider
 * using these tokens; nothing here is a hardcoded job.
 *
 * IMPORTANT: ATS board tokens are set by each company and can change
 * (renamed, migrated to a different ATS, board taken down). This list
 * reflects boards that are publicly documented as using each platform
 * at the time this file was written. Before relying on this in
 * production, verify each token still resolves — see "Known
 * limitations" in the Phase 3 summary. A dead/renamed token fails soft:
 * that one company is skipped (logged), the rest of the sync proceeds.
 *
 * To add a company: add one entry to the relevant array below. No other
 * file needs to change.
 */

export const GREENHOUSE_COMPANIES = [
  { token: "stripe", companyName: "Stripe", companyWebsite: "https://stripe.com" },
  { token: "airbnb", companyName: "Airbnb", companyWebsite: "https://www.airbnb.com" },
  { token: "doordash", companyName: "DoorDash", companyWebsite: "https://www.doordash.com" },
  { token: "robinhood", companyName: "Robinhood", companyWebsite: "https://robinhood.com" },
  { token: "coinbase", companyName: "Coinbase", companyWebsite: "https://www.coinbase.com" },
  { token: "asana", companyName: "Asana", companyWebsite: "https://asana.com" },
  { token: "figma", companyName: "Figma", companyWebsite: "https://www.figma.com" },
  { token: "discord", companyName: "Discord", companyWebsite: "https://discord.com" },
];

export const LEVER_COMPANIES = [
  { token: "netflix", companyName: "Netflix", companyWebsite: "https://www.netflix.com" },
  { token: "palantir", companyName: "Palantir", companyWebsite: "https://www.palantir.com" },
  { token: "attentive", companyName: "Attentive", companyWebsite: "https://www.attentive.com" },
  { token: "rippling", companyName: "Rippling", companyWebsite: "https://www.rippling.com" },
  { token: "brex", companyName: "Brex", companyWebsite: "https://www.brex.com" },
];

export const ASHBY_COMPANIES = [
  { token: "openai", companyName: "OpenAI", companyWebsite: "https://openai.com" },
  { token: "linear", companyName: "Linear", companyWebsite: "https://linear.app" },
  { token: "ramp", companyName: "Ramp", companyWebsite: "https://ramp.com" },
  { token: "vercel", companyName: "Vercel", companyWebsite: "https://vercel.com" },
];
