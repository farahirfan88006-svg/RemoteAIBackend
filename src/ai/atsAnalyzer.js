import { getTagTaxonomyFacets } from "../services/jobQuery.service.js";
import { detectSkillsInText } from "./skillKeywords.js";

/**
 * Rule-based ATS resume analyzer.
 *
 * IMPORTANT — what this is and isn't (see "Known limitations" in the
 * final summary too): this is a deterministic, rule-based scorer, not a
 * machine-learning or LLM-based analysis. There's no model here — every
 * check below is an explicit, readable rule (does the text contain an
 * email address, is there a bullet character, etc.). This is a
 * legitimate and common approach for ATS-style resume checkers, but it's
 * not "AI" in the LLM sense, and it should be described accurately as
 * "automated analysis" rather than implying an ML model was trained.
 *
 * `getTopMarketSkills` deliberately queries the *live* Job collection
 * (via the same `getTagTaxonomyFacets` that already powers `/api/tags`
 * and the frontend's SEO skill pages) — "missing skills" means "missing
 * relative to what's actually in demand on this platform right now", not
 * a static, hardcoded list that goes stale.
 */

const WEAK_PHRASES = [
  "responsible for",
  "duties included",
  "worked on",
  "helped with",
  "tasked with",
];

const SECTION_PATTERNS = {
  contactEmail: /[^\s@]+@[^\s@]+\.[^\s@]+/,
  contactPhone: /(\+?\d[\d\s().-]{7,}\d)/,
  summary: /\b(summary|objective|profile)\b/i,
  experience: /\b(experience|employment|work history)\b/i,
  education: /\b(education|degree|university|college)\b/i,
  skills: /\bskills\b/i,
};

const MIN_WORD_COUNT = 150;
const MAX_WORD_COUNT = 1200;
const TOP_MARKET_SKILLS_LIMIT = 20;
const MISSING_SKILLS_SHOWN = 8;

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function hasBulletPoints(text) {
  return /(^|\n)\s*[•\-*▪●]\s*\S/.test(text);
}

/** Live, DB-derived "what's currently in demand" list — never hardcoded. */
async function getTopMarketSkills(limit = TOP_MARKET_SKILLS_LIMIT) {
  return getTagTaxonomyFacets(limit);
}

/**
 * @param {string} resumeText
 * @returns {Promise<{
 *   atsScore: number,
 *   sectionAnalysis: { present: string[], missing: string[] },
 *   detectedSkills: {name: string, slug: string}[],
 *   missingSkills: {name: string, slug: string}[],
 *   missingKeywords: string[],
 *   formattingIssues: string[],
 *   suggestions: string[],
 * }>}
 */
export async function analyzeResumeText(resumeText) {
  const text = resumeText || "";
  const wordCount = countWords(text);

  let score = 100;
  const suggestions = [];
  const formattingIssues = [];

  // --- Section presence ---
  const sectionChecks = {
    "Contact email": SECTION_PATTERNS.contactEmail.test(text),
    "Contact phone": SECTION_PATTERNS.contactPhone.test(text),
    Summary: SECTION_PATTERNS.summary.test(text),
    Experience: SECTION_PATTERNS.experience.test(text),
    Education: SECTION_PATTERNS.education.test(text),
    Skills: SECTION_PATTERNS.skills.test(text),
  };
  const present = Object.entries(sectionChecks).filter(([, ok]) => ok).map(([name]) => name);
  const missing = Object.entries(sectionChecks).filter(([, ok]) => !ok).map(([name]) => name);

  const SECTION_WEIGHTS = {
    "Contact email": 15,
    "Contact phone": 5,
    Summary: 10,
    Experience: 20,
    Education: 10,
    Skills: 10,
  };
  for (const name of missing) {
    score -= SECTION_WEIGHTS[name] || 5;
    suggestions.push(`Add a clear "${name}" section — ATS systems and recruiters both look for it explicitly.`);
  }

  // --- Length ---
  if (wordCount < MIN_WORD_COUNT) {
    score -= 15;
    formattingIssues.push(`Resume is quite short (${wordCount} words) — ATS systems may read it as incomplete.`);
    suggestions.push("Expand on your experience with more detail — aim for at least 300-600 words.");
  } else if (wordCount > MAX_WORD_COUNT) {
    score -= 5;
    formattingIssues.push(`Resume is quite long (${wordCount} words) — consider tightening it for readability.`);
    suggestions.push("Trim less-relevant details — most ATS-friendly resumes are 1-2 pages (roughly 400-900 words).");
  }

  // --- Bullet points ---
  if (!hasBulletPoints(text)) {
    score -= 5;
    formattingIssues.push("No bullet points detected.");
    suggestions.push("Use bullet points for experience/project entries — they parse more reliably than paragraphs.");
  }

  // --- Weak phrasing ---
  const weakPhrasesFound = WEAK_PHRASES.filter((phrase) => text.toLowerCase().includes(phrase));
  if (weakPhrasesFound.length > 0) {
    const deduction = Math.min(10, weakPhrasesFound.length * 2);
    score -= deduction;
    const quoted = weakPhrasesFound.map((p) => `"${p}"`).join(", ");
    formattingIssues.push(`Passive/weak phrasing found: ${quoted}.`);
    suggestions.push(`Replace passive phrases like ${quoted} with strong action verbs (e.g. "led", "built", "shipped").`);
  }

  // --- Skills vs. live market demand ---
  const detectedSkills = detectSkillsInText(text);
  const detectedSlugs = new Set(detectedSkills.map((s) => s.slug));

  let missingSkills = [];
  try {
    const topMarketSkills = await getTopMarketSkills();
    missingSkills = topMarketSkills
      .filter((skill) => !detectedSlugs.has(skill.slug))
      .slice(0, MISSING_SKILLS_SHOWN)
      .map(({ name, slug }) => ({ name, slug }));
  } catch {
    // Degrades gracefully if the DB is briefly unreachable — the rest of
    // the analysis (which needs no DB access) still returns normally,
    // consistent with this codebase's existing graceful-degradation
    // pattern (see lib/api/tags.js on the frontend for the same idea).
    missingSkills = [];
  }

  if (missingSkills.length > 0) {
    const deduction = Math.min(15, missingSkills.length * 2);
    score -= deduction;
    suggestions.push(
      `Consider adding these in-demand skills if you have them: ${missingSkills.map((s) => s.name).join(", ")}.`,
    );
  }

  const missingKeywords = missingSkills.map((s) => s.name);

  return {
    atsScore: Math.max(0, Math.min(100, Math.round(score))),
    sectionAnalysis: { present, missing },
    detectedSkills,
    missingSkills,
    missingKeywords,
    formattingIssues,
    suggestions,
  };
}
