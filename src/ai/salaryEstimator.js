import { detectSkillsInText } from "./skillKeywords.js";

/**
 * AI Salary Estimator.
 *
 * If the job already has real salaryMin/salaryMax (from the provider),
 * that's returned as-is with `isEstimated: false` — this function never
 * overrides real data with a guess.
 *
 * Otherwise produces a heuristic estimate from category/country/
 * experience/employment-type/skills, clearly marked `isEstimated: true`
 * (per the ticket's "clearly indicate estimated values"). This is a
 * transparent baseline-times-multipliers model, not a market-data API —
 * there's no live salary data source configured in this project — see
 * the file-level numbers below as the (documented, adjustable) baseline.
 */

// Rough baseline USD/year for a *mid-level, full-time, US-based* role in
// each category — deliberately not exhaustive of all ~45 categories;
// unlisted categories fall back to DEFAULT_BASE_SALARY.
const BASE_SALARY_BY_CATEGORY = {
  "software-engineering": 95000,
  "data-and-ai": 105000,
  "devops-and-infrastructure": 100000,
  "product-management": 110000,
  "product-design": 85000,
  "finance-and-accounting": 80000,
  marketing: 65000,
  sales: 70000,
  "customer-support": 48000,
  cybersecurity: 100000,
  "it-and-systems-administration": 75000,
  "blockchain-and-web3": 100000,
  operations: 65000,
  "human-resources": 65000,
  legal: 90000,
  consulting: 90000,
  healthcare: 70000,
  "qa-and-testing": 75000,
  "founder-and-executive-leadership": 140000,
  "banking-and-insurance": 80000,
  "education-and-training": 55000,
  "writing-and-editorial": 55000,
  administrative: 45000,
};
const DEFAULT_BASE_SALARY = 60000;

const EXPERIENCE_MULTIPLIER = { entry: 0.7, mid: 1.0, senior: 1.35, lead: 1.7 };
const EMPLOYMENT_TYPE_MULTIPLIER = {
  "full-time": 1.0,
  "part-time": 0.55,
  contract: 1.05,
  freelance: 1.0,
  internship: 0.35,
};

// A small, explicit set of common markets; anything unlisted uses
// DEFAULT_COUNTRY_MULTIPLIER. This is a coarse cost-of-living/market-rate
// proxy, not a real compensation-survey dataset.
const COUNTRY_MULTIPLIER = {
  "united states": 1.0,
  "united kingdom": 0.85,
  canada: 0.82,
  germany: 0.8,
  france: 0.75,
  australia: 0.95,
  netherlands: 0.85,
  ireland: 0.85,
  spain: 0.6,
  poland: 0.5,
  india: 0.32,
  philippines: 0.28,
  brazil: 0.4,
  mexico: 0.4,
  "south africa": 0.35,
};
const DEFAULT_COUNTRY_MULTIPLIER = 0.7;

const SKILL_BONUS_PER_SKILL = 0.02; // +2% per in-demand skill detected
const MAX_SKILL_BONUS = 0.2; // capped at +20%

/**
 * @param {object} job - a serialized job (see jobQuery.service.js#serializeJob)
 * @returns {{ min: number, max: number, average: number, currency: string, isEstimated: boolean }}
 */
export function estimateSalary(job) {
  const currency = job.salaryCurrency || "USD";

  if (typeof job.salaryMin === "number" && typeof job.salaryMax === "number") {
    return {
      min: job.salaryMin,
      max: job.salaryMax,
      average: Math.round((job.salaryMin + job.salaryMax) / 2),
      currency,
      isEstimated: false,
    };
  }

  const base = BASE_SALARY_BY_CATEGORY[job.category] ?? DEFAULT_BASE_SALARY;
  const experienceMult = EXPERIENCE_MULTIPLIER[job.experienceLevel] ?? 1.0;
  const employmentMult = EMPLOYMENT_TYPE_MULTIPLIER[job.employmentType] ?? 1.0;
  const countryKey = String(job.country || "").toLowerCase().trim();
  const countryMult = COUNTRY_MULTIPLIER[countryKey] ?? DEFAULT_COUNTRY_MULTIPLIER;

  const skillText = [job.title, job.description, ...(job.tags || [])].filter(Boolean).join(" ");
  const skillCount = detectSkillsInText(skillText).length;
  const skillBonus = Math.min(MAX_SKILL_BONUS, skillCount * SKILL_BONUS_PER_SKILL);

  const average = Math.round(base * experienceMult * employmentMult * countryMult * (1 + skillBonus));
  const min = Math.round(average * 0.85);
  const max = Math.round(average * 1.15);

  return { min, max, average, currency, isEstimated: true };
}
