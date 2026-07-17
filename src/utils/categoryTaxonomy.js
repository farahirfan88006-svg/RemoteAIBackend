/**
 * categoryTaxonomy.js
 *
 * Providers label departments/categories inconsistently ("Software
 * Engineer", "Engineering - Backend", "R&D", "Full Stack Development" all
 * really mean the same thing). This module is the single place that
 * normalizes a raw provider-supplied category string into one of a small,
 * curated set of canonical categories, so `/api/categories` and the
 * `category` filter deal with ~45 meaningful buckets instead of hundreds
 * of near-duplicate provider-specific labels.
 *
 * Used by normalizeJobRecord.js at ingestion time (so every stored Job
 * document already has a canonical category), and re-exported for the
 * optional backfill script (scripts/backfillTaxonomy.js).
 *
 * Matching strategy:
 *   1. Lowercase + trim the raw value.
 *   2. Exact match against a known alias -> canonical category.
 *   3. Substring/keyword match against each canonical category's alias
 *      list (order matters: more specific categories are listed before
 *      broader catch-alls).
 *   4. No match -> canonical "Other" bucket, rather than inventing a new
 *      category per unmapped provider string.
 *
 * Nothing here talks to MongoDB — pure string in, { name, slug } out.
 */

/**
 * Canonical taxonomy. Each entry's `aliases` are lowercase keywords or
 * phrases; a raw category matches an entry if it equals, starts with,
 * or contains one of these. Keep more specific entries earlier in the
 * list than broader ones they could otherwise be swallowed by.
 */
const CATEGORY_TAXONOMY = [
  // NOTE: order matters — Software Engineering's generic aliases
  // ("engineer", "developer", "engineering") are broad enough to
  // substring-match role titles that really belong to the more specific
  // categories below (e.g. "iOS Developer", "Site Reliability Engineer",
  // "Data Engineer"), so those specific categories are listed — and
  // therefore matched — first.
  {
    name: "Mobile Development",
    aliases: ["mobile", "ios", "android", "react native", "flutter", "app development"],
  },
  {
    name: "DevOps & Infrastructure",
    aliases: [
      "devops", "dev ops", "infrastructure", "site reliability", "sre",
      "platform ops", "cloud engineering", "cloud infrastructure", "release engineering",
    ],
  },
  {
    name: "Cybersecurity",
    aliases: ["security", "cybersecurity", "infosec", "information security", "application security"],
  },
  {
    name: "QA & Testing",
    aliases: ["qa", "quality assurance", "quality engineering", "testing", "test engineer", "sdet"],
  },
  {
    name: "Data & AI",
    aliases: [
      "data science", "data scientist", "machine learning", "ml engineer", "ai",
      "artificial intelligence", "analytics", "data analytics", "data analyst",
      "data engineering", "data engineer", "deep learning", "nlp", "computer vision",
      "big data", "mlops",
    ],
  },
  {
    name: "IT & Systems Administration",
    aliases: ["it support", "information technology", "system administrator", "sysadmin", "network administrator", "network engineer", "helpdesk technician"],
  },
  {
    name: "Game Development",
    aliases: ["game development", "game designer", "game developer", "gameplay", "unity developer", "unreal engine"],
  },
  {
    name: "Blockchain & Web3",
    aliases: ["blockchain", "web3", "crypto", "cryptocurrency", "smart contract", "defi", "blockchain developer", "blockchain engineer"],
  },
  {
    name: "Hardware Engineering",
    aliases: ["hardware engineer", "electrical engineering", "mechanical engineering", "hardware", "electronics engineer"],
  },
  {
    name: "Solutions Engineering",
    aliases: ["solutions engineer", "sales engineer", "pre-sales", "presales", "technical account manager"],
  },
  {
    name: "Solutions Architecture",
    aliases: ["solutions architect", "technical architect", "enterprise architect", "cloud architect"],
  },
  {
    name: "Software Engineering",
    aliases: [
      "software engineer", "software development", "software dev", "engineering",
      "backend engineering", "back-end", "backend", "back end",
      "frontend engineering", "front-end", "frontend", "front end",
      "full stack", "fullstack", "full-stack",
      "web development", "web developer", "application development",
      "platform engineering", "systems engineering", "embedded", "firmware",
      "developer", "programming", "engineer", "r&d", "research and development",
    ],
  },
  {
    name: "Product Management",
    aliases: ["product management", "product manager", "product owner", "product"],
  },
  {
    name: "Product Design",
    aliases: [
      "design", "product design", "ux", "ui", "ux/ui", "ui/ux", "user experience",
      "user research", "graphic design", "visual design", "interaction design",
    ],
  },
  {
    name: "Customer Support",
    aliases: [
      "customer success", "customer support", "support", "customer service",
      "technical support", "helpdesk", "help desk", "client success",
    ],
  },
  {
    name: "Marketing",
    aliases: [
      "marketing", "growth", "seo", "sem", "content marketing", "digital marketing",
      "performance marketing", "brand marketing", "social media", "communications",
      "pr", "public relations", "content", "copywriting", "growth marketing",
    ],
  },
  {
    name: "Sales",
    aliases: [
      "sales", "account executive", "business development", "bdr", "sdr",
      "account management", "partnerships", "revenue",
    ],
  },
  {
    name: "Business Analysis",
    aliases: ["business analyst", "business analysis", "requirements analyst", "systems analyst"],
  },
  {
    name: "Operations",
    aliases: ["operations", "business operations", "revenue operations", "revops", "office management"],
  },
  {
    name: "Project & Program Management",
    aliases: ["project management", "program management", "technical program", "scrum master", "agile", "delivery management"],
  },
  {
    name: "Human Resources",
    aliases: ["human resources", "hr", "people ops", "people operations", "talent", "recruiting", "recruitment", "talent acquisition"],
  },
  {
    name: "Finance & Accounting",
    aliases: ["finance", "accounting", "financial", "bookkeeping", "controller", "payroll", "tax"],
  },
  {
    name: "Banking & Insurance",
    aliases: ["banking", "insurance", "underwriting", "actuarial", "claims"],
  },
  {
    name: "Legal",
    aliases: ["legal", "compliance", "counsel", "paralegal", "regulatory"],
  },
  {
    name: "Consulting",
    aliases: ["consulting", "advisory", "consultant"],
  },
  {
    name: "Healthcare",
    aliases: ["healthcare", "health care", "medical", "clinical", "nursing", "pharma", "pharmaceutical"],
  },
  {
    name: "Education & Training",
    aliases: ["education", "teaching", "training", "instructional design", "curriculum", "academic"],
  },
  {
    name: "Video & Animation",
    aliases: ["video production", "video editing", "video editor", "animation", "motion graphics", "videographer"],
  },
  {
    name: "Writing & Editorial",
    aliases: ["writing", "editorial", "journalism", "technical writing", "copy editor", "content editor", "blogger"],
  },
  {
    name: "Localization & Translation",
    aliases: ["localization", "localisation", "translation", "translator", "interpreter"],
  },
  {
    name: "Photography",
    aliases: ["photography", "photographer"],
  },
  {
    name: "Manufacturing & Supply Chain",
    aliases: ["manufacturing", "supply chain", "logistics", "procurement", "warehouse"],
  },
  {
    name: "Real Estate",
    aliases: ["real estate", "property management"],
  },
  {
    name: "Hospitality & Travel",
    aliases: ["hospitality", "travel", "tourism", "hotel"],
  },
  {
    name: "Retail",
    aliases: ["retail", "merchandising", "store operations"],
  },
  {
    name: "Fashion & Apparel",
    aliases: ["fashion", "apparel", "textile"],
  },
  {
    name: "Agriculture",
    aliases: ["agriculture", "farming", "agritech", "agronomy"],
  },
  {
    name: "Energy & Utilities",
    aliases: ["energy", "utilities", "renewable energy", "oil and gas", "solar"],
  },
  {
    name: "Telecommunications",
    aliases: ["telecom", "telecommunications"],
  },
  {
    name: "Government & Public Sector",
    aliases: ["government", "public sector", "federal", "civil service", "public policy"],
  },
  {
    name: "Event Management",
    aliases: ["event management", "event planning", "events"],
  },
  {
    name: "Facilities & Environmental",
    aliases: ["facilities", "environmental", "sustainability", "ehs", "health and safety"],
  },
  {
    name: "Non-profit & Community",
    aliases: ["non-profit", "nonprofit", "ngo", "community", "social impact", "volunteer"],
  },
  {
    name: "Founder & Executive Leadership",
    aliases: ["founder", "co-founder", "chief of staff", "executive leadership", "ceo", "coo", "cfo", "cto"],
  },
  {
    name: "Administrative",
    aliases: ["administrative", "admin", "executive assistant", "office administration", "clerical"],
  },
];

const OTHER_CATEGORY = { name: "Other", slug: "other" };

/** Simple, dependency-free slugifier consistent with the rest of the backend. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Precompute slugs once at module load.
const TAXONOMY_WITH_SLUGS = CATEGORY_TAXONOMY.map((entry) => ({
  ...entry,
  slug: slugify(entry.name),
}));

/**
 * Normalizes a raw, provider-supplied category/department string into a
 * canonical { name, slug } pair.
 *
 * @param {string|undefined|null} rawCategory
 * @returns {{ name: string, slug: string } | undefined} undefined only
 *   when `rawCategory` itself is empty — a non-empty value that matches
 *   nothing still resolves to the "Other" bucket.
 */
export function normalizeCategory(rawCategory) {
  const raw = String(rawCategory || "").trim();
  if (!raw) return undefined;

  const haystack = raw.toLowerCase();

  // 1. Exact / startsWith match against any alias.
  for (const entry of TAXONOMY_WITH_SLUGS) {
    if (entry.aliases.some((alias) => haystack === alias)) {
      return { name: entry.name, slug: entry.slug };
    }
  }

  // 2. Substring match — first (most specific) entry wins.
  for (const entry of TAXONOMY_WITH_SLUGS) {
    if (entry.aliases.some((alias) => haystack.includes(alias))) {
      return { name: entry.name, slug: entry.slug };
    }
  }

  // 3. No match — bounded catch-all rather than inventing a new category.
  return OTHER_CATEGORY;
}

export const CATEGORY_TAXONOMY_LIST = TAXONOMY_WITH_SLUGS;
