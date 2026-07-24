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
 *
 * ---------------------------------------------------------------------
 * Backward compatibility note (quality pass):
 * The return shape's original keys (atsScore, sectionAnalysis,
 * detectedSkills, missingSkills, missingKeywords, formattingIssues,
 * suggestions) are all still present with the exact same types, since
 * this function feeds both the text-based Resume Analyzer route
 * (resumeAnalyzer.controller.js) and the file-upload-based one
 * (analyzer.controller.js -> ResumeAnalysis model). Everything below is
 * purely *additive* — richer scoring breakdown, section-by-section
 * feedback, quantification/action-verb coaching, and a headline
 * grade/summary — so neither existing consumer breaks.
 * ---------------------------------------------------------------------
 */

const WEAK_PHRASES = [
  "responsible for",
  "duties included",
  "worked on",
  "helped with",
  "tasked with",
  "in charge of",
  "involved in",
  "participated in",
];

const STRONG_ACTION_VERBS = [
  "led", "built", "designed", "developed", "implemented", "launched",
  "architected", "optimized", "automated", "reduced", "increased",
  "improved", "delivered", "managed", "created", "drove", "spearheaded",
  "streamlined", "scaled", "engineered", "shipped", "founded", "negotiated",
  "mentored", "owned", "accelerated", "generated", "cut", "boosted",
  "transformed", "modernized", "migrated", "resolved", "established",
];

const SECTION_PATTERNS = {
  contactEmail: /[^\s@]+@[^\s@]+\.[^\s@]+/,
  contactPhone: /(\+?\d[\d\s().-]{7,}\d)/,
  summary: /\b(summary|objective|profile)\b/i,
  experience: /\b(experience|employment|work history)\b/i,
  education: /\b(education|degree|university|college)\b/i,
  skills: /\bskills\b/i,
};

const SECTION_GUIDANCE = {
  "Contact email": {
    present: "Recruiters and ATS parsers can reach you directly — this is table stakes and you have it.",
    missing: "No email address detected. Most ATS platforms discard resumes they can't parse contact info from.",
  },
  "Contact phone": {
    present: "A phone number is present, giving recruiters a fast, direct way to reach you.",
    missing: "No phone number detected. Include one — some recruiters still prefer a quick call to schedule screens.",
  },
  Summary: {
    present: "A summary/objective section gives readers a fast, framed first impression of who you are.",
    missing: "No summary/objective/profile section found. A tight 2-3 line summary at the top helps both ATS keyword matching and a recruiter's 6-second skim.",
  },
  Experience: {
    present: "A clearly labeled experience section is present — this is the section recruiters and ATS weigh most heavily.",
    missing: "No clearly labeled experience/employment section detected. This is the single most heavily-weighted section for ATS parsing — label it explicitly.",
  },
  Education: {
    present: "Education is present and clearly labeled.",
    missing: "No education section detected. Even a brief one (degree, school, year) helps ATS completeness checks.",
  },
  Skills: {
    present: "A dedicated skills section makes keyword matching easy for both ATS software and quick human scans.",
    missing: "No dedicated \"Skills\" section found. Recruiters and ATS keyword filters both scan for one explicitly — bullet points buried in prose are often missed.",
  },
};

const SECTION_WEIGHTS = {
  "Contact email": 15,
  "Contact phone": 5,
  Summary: 10,
  Experience: 20,
  Education: 10,
  Skills: 10,
};

const MIN_WORD_COUNT = 150;
const IDEAL_MIN_WORD_COUNT = 300;
const IDEAL_MAX_WORD_COUNT = 900;
const MAX_WORD_COUNT = 1200;
const TOP_MARKET_SKILLS_LIMIT = 20;
const MISSING_SKILLS_SHOWN = 8;

const GRADE_BANDS = [
  { min: 90, grade: "A", label: "Excellent — ATS-ready" },
  { min: 80, grade: "B+", label: "Strong — minor polish needed" },
  { min: 70, grade: "B", label: "Good — a few gaps to close" },
  { min: 55, grade: "C", label: "Needs work — several issues to fix" },
  { min: 40, grade: "D", label: "Weak — significant revision recommended" },
  { min: 0, grade: "F", label: "Needs a rebuild before applying" },
];

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function getLines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function getBulletLines(text) {
  return getLines(text).filter((line) => /^[•\-*▪●]\s*\S/.test(line));
}

function hasBulletPoints(text) {
  return /(^|\n)\s*[•\-*▪●]\s*\S/.test(text);
}

function gradeForScore(score) {
  return GRADE_BANDS.find((band) => score >= band.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
}

/** Does a line contain a quantifiable result — a number, %, $, or multiplier? */
function isQuantified(line) {
  return /(\$\s?\d|\d+(\.\d+)?\s?%|\d+(\.\d+)?\s?(x|k|m|million|billion|hours?|days?|weeks?|months?|years?|users?|customers?|clients?|points?|pp)\b|\b\d{2,}\b)/i.test(
    line,
  );
}

/** Does a line open with a strong past/present-tense action verb? */
function startsWithActionVerb(line) {
  const firstWord = line.replace(/^[•\-*▪●]\s*/, "").split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (!firstWord) return false;
  return STRONG_ACTION_VERBS.some((verb) => firstWord === verb || firstWord === `${verb}s`);
}

/** Live, DB-derived "what's currently in demand" list — never hardcoded. */
async function getTopMarketSkills(limit = TOP_MARKET_SKILLS_LIMIT) {
  return getTagTaxonomyFacets(limit);
}

/**
 * @param {string} resumeText
 * @returns {Promise<{
 *   atsScore: number,
 *   grade: string,
 *   ratingLabel: string,
 *   summary: string,
 *   strengths: string[],
 *   scoreBreakdown: Record<string, number>,
 *   sectionAnalysis: { present: string[], missing: string[] },
 *   sectionFeedback: {name: string, present: boolean, note: string}[],
 *   detectedSkills: {name: string, slug: string}[],
 *   missingSkills: {name: string, slug: string, count?: number}[],
 *   missingKeywords: string[],
 *   quantification: { quantifiedBullets: number, totalBullets: number, ratio: number },
 *   actionVerbs: { strongBullets: number, totalBullets: number, ratio: number },
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
  const strengths = [];
  const scoreBreakdown = {};

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

  const sectionFeedback = Object.entries(sectionChecks).map(([name, ok]) => ({
    name,
    present: ok,
    note: ok ? SECTION_GUIDANCE[name].present : SECTION_GUIDANCE[name].missing,
  }));

  let sectionDeduction = 0;
  for (const name of missing) {
    sectionDeduction += SECTION_WEIGHTS[name] || 5;
    suggestions.push(`Add a clear "${name}" section — ATS systems and recruiters both look for it explicitly.`);
  }
  if (sectionDeduction > 0) {
    score -= sectionDeduction;
    scoreBreakdown.missingSections = -sectionDeduction;
  }
  if (present.length === Object.keys(sectionChecks).length) {
    strengths.push("All core resume sections (contact info, summary, experience, education, skills) are present.");
  }

  // --- Length ---
  if (wordCount < MIN_WORD_COUNT) {
    score -= 15;
    scoreBreakdown.length = -15;
    formattingIssues.push(`Resume is quite short (${wordCount} words) — ATS systems may read it as incomplete.`);
    suggestions.push(`Expand on your experience with more detail — aim for at least ${IDEAL_MIN_WORD_COUNT}-${IDEAL_MAX_WORD_COUNT} words.`);
  } else if (wordCount > MAX_WORD_COUNT) {
    score -= 5;
    scoreBreakdown.length = -5;
    formattingIssues.push(`Resume is quite long (${wordCount} words) — consider tightening it for readability.`);
    suggestions.push(`Trim less-relevant details — most ATS-friendly resumes are 1-2 pages (roughly ${IDEAL_MIN_WORD_COUNT}-${IDEAL_MAX_WORD_COUNT} words).`);
  } else {
    strengths.push(`Resume length (${wordCount} words) is in the ideal range recruiters and ATS parsers handle best.`);
  }

  // --- Bullet points ---
  const bulletLines = getBulletLines(text);
  if (!hasBulletPoints(text)) {
    score -= 5;
    scoreBreakdown.bulletFormatting = -5;
    formattingIssues.push("No bullet points detected.");
    suggestions.push("Use bullet points for experience/project entries — they parse more reliably than paragraphs.");
  }

  // --- Weak phrasing ---
  const weakPhrasesFound = WEAK_PHRASES.filter((phrase) => text.toLowerCase().includes(phrase));
  if (weakPhrasesFound.length > 0) {
    const deduction = Math.min(10, weakPhrasesFound.length * 2);
    score -= deduction;
    scoreBreakdown.weakPhrasing = -deduction;
    const quoted = weakPhrasesFound.map((p) => `"${p}"`).join(", ");
    formattingIssues.push(`Passive/weak phrasing found: ${quoted}.`);
    suggestions.push(`Replace passive phrases like ${quoted} with strong action verbs (e.g. "led", "built", "shipped").`);
  }

  // --- Action verbs at the start of bullets ---
  let actionVerbs = { strongBullets: 0, totalBullets: bulletLines.length, ratio: 0 };
  if (bulletLines.length > 0) {
    const strongBullets = bulletLines.filter(startsWithActionVerb).length;
    const ratio = strongBullets / bulletLines.length;
    actionVerbs = { strongBullets, totalBullets: bulletLines.length, ratio: Math.round(ratio * 100) / 100 };
    if (ratio < 0.4) {
      const deduction = 8;
      score -= deduction;
      scoreBreakdown.actionVerbUsage = -deduction;
      suggestions.push(
        `Only ${strongBullets}/${bulletLines.length} bullets open with a strong action verb — start each one with a verb like "led", "built", or "launched" instead of a noun or "I".`,
      );
    } else if (ratio >= 0.7) {
      strengths.push(`Most bullets (${strongBullets}/${bulletLines.length}) open with strong action verbs — that reads as confident and results-oriented.`);
    }
  }

  // --- Quantified impact ---
  let quantification = { quantifiedBullets: 0, totalBullets: bulletLines.length, ratio: 0 };
  if (bulletLines.length > 0) {
    const quantifiedBullets = bulletLines.filter(isQuantified).length;
    const ratio = quantifiedBullets / bulletLines.length;
    quantification = { quantifiedBullets, totalBullets: bulletLines.length, ratio: Math.round(ratio * 100) / 100 };
    if (ratio < 0.3) {
      const deduction = 10;
      score -= deduction;
      scoreBreakdown.quantifiedImpact = -deduction;
      suggestions.push(
        `Only ${quantifiedBullets}/${bulletLines.length} bullets include a measurable result — add numbers, percentages, or dollar amounts (e.g. "cut page load time by 40%", "grew MRR from $10k to $45k").`,
      );
    } else if (ratio >= 0.5) {
      strengths.push(`Good use of metrics — ${quantifiedBullets}/${bulletLines.length} bullets quantify impact with numbers.`);
    }
  }

  // --- Skills vs. live market demand ---
  const detectedSkills = detectSkillsInText(text);
  const detectedSlugs = new Set(detectedSkills.map((s) => s.slug));

  if (detectedSkills.length >= 6) {
    strengths.push(`Resume mentions a solid breadth of recognizable technical skills (${detectedSkills.length} detected).`);
  }

  let missingSkills = [];
  try {
    const topMarketSkills = await getTopMarketSkills();
    missingSkills = topMarketSkills
      .filter((skill) => !detectedSlugs.has(skill.slug))
      .slice(0, MISSING_SKILLS_SHOWN)
      .map(({ name, slug, count }) => (count != null ? { name, slug, count } : { name, slug }));
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
    scoreBreakdown.keywordGap = -deduction;
    suggestions.push(
      `Consider adding these in-demand skills if you have them: ${missingSkills.map((s) => s.name).join(", ")}.`,
    );
  }

  const missingKeywords = missingSkills.map((s) => s.name);

  const atsScore = Math.max(0, Math.min(100, Math.round(score)));
  const { grade, label: ratingLabel } = gradeForScore(atsScore);

  // De-dupe/limit suggestions so the premium summary reads as curated,
  // prioritized advice rather than an unbounded checklist dump.
  const prioritizedSuggestions = [...new Set(suggestions)].slice(0, 6);

  const summary = buildExecutiveSummary({
    atsScore,
    ratingLabel,
    missing,
    quantification,
    actionVerbs,
    missingSkillsCount: missingSkills.length,
  });

  return {
    atsScore,
    grade,
    ratingLabel,
    summary,
    strengths,
    scoreBreakdown,
    sectionAnalysis: { present, missing },
    sectionFeedback,
    detectedSkills,
    missingSkills,
    missingKeywords,
    quantification,
    actionVerbs,
    formattingIssues,
    suggestions: prioritizedSuggestions,
  };
}

/** Builds a short, human, one-paragraph executive summary from the computed signals. */
function buildExecutiveSummary({ atsScore, ratingLabel, missing, quantification, actionVerbs, missingSkillsCount }) {
  const parts = [];
  parts.push(`This resume scores ${atsScore}/100 (${ratingLabel}).`);

  if (missing.length === 0) {
    parts.push("All core sections are present, which gives ATS parsers a clean structure to work with.");
  } else {
    parts.push(`It's missing ${missing.length === 1 ? "a" : missing.length} key section${missing.length > 1 ? "s" : ""} (${missing.join(", ")}), which ATS software and recruiters both look for first.`);
  }

  if (quantification.totalBullets > 0) {
    if (quantification.ratio < 0.3) {
      parts.push("Most bullet points describe duties rather than measurable outcomes — adding numbers would make the impact easier to scan.");
    } else {
      parts.push("Bullet points do a reasonable job of quantifying impact.");
    }
  }

  if (actionVerbs.totalBullets > 0 && actionVerbs.ratio < 0.4) {
    parts.push("Leading bullets with stronger action verbs would also sharpen the overall tone.");
  }

  if (missingSkillsCount > 0) {
    parts.push(`There are also ${missingSkillsCount} in-demand skill${missingSkillsCount > 1 ? "s" : ""} on the platform right now that aren't reflected in the resume text.`);
  }

  return parts.join(" ");
}
