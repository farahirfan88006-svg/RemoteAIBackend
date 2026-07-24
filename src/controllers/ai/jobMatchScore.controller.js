/**
 * src/controllers/ai/jobMatchScore.controller.js
 * ---------------------------------------------------------------------------
 * Job Match Score (text-only, JSON) controller.
 *
 * Reuses the existing shared AI architecture under lib/ai instead of
 * building new plumbing:
 *   - lib/ai/services/aiService.js        (runAIFeature — provider-agnostic entry point)
 *   - lib/ai/providers/*                  (resolved internally by aiService)
 *   - lib/ai/services/historyService.js   (AIHistory persistence)
 *   - src/middleware/checkUsageLimit.js / incrementUsage.js (usage limits, wired in the route)
 *   - src/middleware/requireAuth.js       (auth, wired in the route)
 *
 * This module intentionally mirrors src/controllers/ai/resumeAnalyzer.controller.js,
 * src/controllers/ai/resumeRewrite.controller.js, src/controllers/ai/careerCoach.controller.js,
 * src/controllers/ai/coverLetterAI.controller.js, and
 * src/controllers/ai/mockInterview.controller.js so the shared AI
 * architecture is used consistently across features. lib/ai is loaded with
 * a *dynamic* import wrapped in try/catch rather than a static top-of-file
 * import, so a failure there (not yet wired, provider stub not implemented,
 * transient error) can be caught per request instead of crashing the app.
 *
 * IMPORTANT — how scoring works here (different from the other AI
 * features): the match score is NEVER decided by the AI provider. It is
 * always computed by a deterministic, rule-based algorithm
 * (`calculateMatchScore` below), the same "explicit, readable rules, not an
 * ML/LLM model" approach already used by src/ai/atsAnalyzer.js. The shared
 * AI architecture is only ever used, optionally, to add a plain-language,
 * premium-recruiter-style write-up *on top of* the already-final score — if
 * that call fails or the provider is unavailable, this controller falls
 * back to an equally rich, rule-based write-up built from the same
 * deterministic analysis and still returns the full, real, algorithmic
 * score. The request never fails just because the AI provider is
 * unreachable.
 *
 * Scoring depth (Phase — Job Match Score quality upgrade):
 *   The score is now a weighted blend of EIGHT separately-analyzed signals
 *   instead of four: skills, technology/tools, experience (years/seniority
 *   basis), education, project/domain scope, responsibilities (ownership &
 *   action verbs), seniority level, and general keyword/ATS overlap. Each
 *   signal reports its own matched/missing items and percentage so the
 *   response can explain *why* the score is what it is, not just *what* it
 *   is. Missing items also carry an estimated point impact so the candidate
 *   can see which gaps matter most. All of this is still plain arithmetic
 *   over string/keyword matching — no ML/LLM model decides any number.
 *
 * This module only implements the Job Match Score feature. It does not
 * touch Resume Analyzer, Resume Rewrite, Career Coach, Cover Letter AI,
 * Mock Interview, or any other route, and it does not add any new models.
 * The response envelope and every field that existed before this upgrade
 * (score, matchedSkills, missingSkills, strengths, improvements, breakdown,
 * insights, input, feature, provider, fallback) keeps the same name and
 * type; everything new is additive.
 */

import { detectSkillsInText } from "../../ai/skillKeywords.js";

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "matchScore";

const MIN_RESUME_TEXT_LENGTH = 50;
const MAX_RESUME_TEXT_LENGTH = 12000;

const MIN_JOB_DESCRIPTION_LENGTH = 20;
const MAX_JOB_DESCRIPTION_LENGTH = 8000;

const MIN_SKILLS_LENGTH = 2;
const MAX_SKILLS_LENGTH = 1000;

const MIN_EXPERIENCE_LENGTH = 1;
const MAX_EXPERIENCE_LENGTH = 1000;

const MIN_EDUCATION_LENGTH = 1;
const MAX_EDUCATION_LENGTH = 500;

// Headroom added on top of the sum of the individual field maximums so the
// combined prompt (all five fields plus labels/newlines/analysis context,
// built below) doesn't itself trip the aiService maxLength check for
// borderline inputs. The richer analysis payload sent to the AI provider is
// larger than before, so this has more headroom than the original.
const PROMPT_LENGTH_HEADROOM = 4000;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_RESUME_TEXT_LENGTH +
  MAX_JOB_DESCRIPTION_LENGTH +
  MAX_SKILLS_LENGTH +
  MAX_EXPERIENCE_LENGTH +
  MAX_EDUCATION_LENGTH +
  PROMPT_LENGTH_HEADROOM;

const SYSTEM_INSTRUCTIONS =
  "You are the Job Match Score feature of the RemoteAI platform, writing in the voice of a " +
  "premium, candid AI recruiter — insightful and specific, never a generic keyword checker. " +
  "A backend algorithm has ALREADY calculated the candidate's match score and the full " +
  "per-category analysis (skills, technology, experience, education, projects, " +
  "responsibilities, seniority, keywords) — you are NOT calculating or restating a different " +
  "score, and you must not contradict any number given to you. Your only job is to turn that " +
  "already-final analysis into a well-organized, easy-to-read write-up with clear Markdown " +
  "section headers and bullet points. Cover, in your own specific and varied wording (never " +
  "reuse the same stock sentence twice): (1) a short overall verdict on fit that references " +
  "concrete matched/missing items, (2) strengths explained with specifics rather than 'good " +
  "match', (3) the highest-impact gaps first, referencing the point-impact numbers you were " +
  "given, (4) interview readiness, (5) concrete resume edits that would raise this specific " +
  "score, and (6) a one-paragraph explanation of why the candidate is or isn't a strong fit. " +
  "Never invent experience, employers, skills, or qualifications the candidate did not " +
  "mention, and never invent a fact not present in the analysis you were given.";

/* ---------------------------------------------------------------------- */
/* Sanitization (mirrors lib/ai/validators/sanitizeInput.js's `sanitize()`) */
/* ---------------------------------------------------------------------- */

/**
 * Strips whitespace/control characters that have no legitimate place in
 * submitted free-text fields.
 * @param {string} value
 * @returns {string}
 */
function sanitizeText(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * skills may arrive as a comma/newline separated string or as an array of
 * individual skill strings — normalize either shape into a single
 * sanitized, comma-separated string (same normalization careerCoach's
 * currentSkills / mockInterview's skills fields use, for consistency).
 * @param {*} value
 * @returns {string|null} null if the shape is invalid
 */
function normalizeSkillsInput(value) {
  if (typeof value === "string") {
    return sanitizeText(value.replace(/\n/g, ", ")).replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((item) => typeof item === "string")
      .map((item) => sanitizeText(item).replace(/\s+/g, " ").trim())
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) return null;
    return cleaned.join(", ");
  }
  return null;
}

/**
 * Standard API response envelope used throughout this project (matches
 * requireAuth.js / checkUsageLimit.js / incrementUsage.js / responseBuilder.js).
 */
function respond({ success, message, plan = null, usageRemaining = null, data = null, errors = [] }) {
  return { success, message, plan, usageRemaining, data, errors };
}

/* ---------------------------------------------------------------------- */
/* Deterministic scoring algorithm — the AI never decides this            */
/* ---------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "have", "has", "will", "you", "your",
  "are", "our", "from", "into", "who", "whom", "such", "than", "then", "them", "their",
  "about", "across", "over", "under", "each", "some", "any", "all", "not", "but",
  "can", "able", "using", "used", "use", "work", "works", "working", "job", "role",
  "team", "teams", "years", "year", "experience", "skills", "skill", "candidate",
  "must", "should", "would", "could", "also", "including", "include", "includes",
  "required", "requirement", "requirements", "preferred", "responsibilities",
  "responsible", "looking", "strong", "excellent", "ability", "knowledge",
]);

/** Splits comma/semicolon/newline separated free text into clean, deduped, lowercase phrases. */
function tokenizePhraseList(value) {
  return Array.from(
    new Set(
      (value || "")
        .split(/[,;\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 1),
    ),
  );
}

/** Extracts significant single-word keywords (4+ letters, stopwords removed) from free text. */
function extractKeywordSet(text) {
  const words = (text || "").toLowerCase().match(/[a-z][a-z0-9+.#-]{3,}/g) || [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/** Jaccard-style overlap ratio between two keyword sets (0 when both are empty). */
function keywordOverlapRatio(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Title-cases a lowercase phrase for display (e.g. "project management" -> "Project Management"). */
function toDisplayCase(phrase) {
  return phrase.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Dedupes a list of display strings case-insensitively, keeping the first casing seen for each. */
function dedupeCaseInsensitive(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

/** Clamps a ratio into the valid [0, 1] range. */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Skills component: matches the candidate's explicitly-listed `skills`
 * field against keywords/phrases appearing in the job description
 * (case-insensitive substring matching), blended with a general keyword
 * overlap between the resume+skills text and the job description as a
 * whole.
 */
function computeSkillsMatch({ skillPhrases, jobDescriptionLower, resumeText, skills, jobDescription }) {
  const matchedPhrases = skillPhrases.filter((phrase) => jobDescriptionLower.includes(phrase));
  const phraseMatchRatio = skillPhrases.length > 0 ? matchedPhrases.length / skillPhrases.length : 0;

  const candidateKeywords = extractKeywordSet(`${resumeText}\n${skills}`);
  const jobKeywords = extractKeywordSet(jobDescription);
  const generalOverlapRatio = keywordOverlapRatio(candidateKeywords, jobKeywords);

  // Weighted blend: explicit skill claims matter more than generic overlap.
  const ratio = skillPhrases.length > 0 ? phraseMatchRatio * 0.7 + generalOverlapRatio * 0.3 : generalOverlapRatio;

  const missingPhrases = skillPhrases.filter((phrase) => !jobDescriptionLower.includes(phrase));

  return {
    ratio: clamp01(ratio),
    matched: matchedPhrases.map(toDisplayCase),
    missing: missingPhrases.map(toDisplayCase),
    totalListed: skillPhrases.length,
  };
}

/**
 * Technology component: uses the shared `detectSkillsInText` taxonomy (the
 * same one the Resume Analyzer / Cover Letter / Mock Interview fallbacks
 * use) to find concrete technologies (languages, frameworks, cloud, tools)
 * mentioned in the job description, then checks how many of those are also
 * present in the candidate's resume+skills text. Distinct from the
 * freeform skills-field matching above — this is a narrower, canonical
 * tech-stack match.
 */
function computeTechnologyMatch({ resumeText, skills, jobDescription }) {
  const jobTech = detectSkillsInText(jobDescription);
  const candidateTech = detectSkillsInText(`${resumeText}\n${skills}`);
  const candidateSlugs = new Set(candidateTech.map((t) => t.slug));

  if (jobTech.length === 0) {
    // Job description doesn't mention any known technology by name — don't
    // penalize the candidate for something the job never asked for.
    return { ratio: 1, matched: [], missing: [], totalRequired: 0 };
  }

  const matched = jobTech.filter((t) => candidateSlugs.has(t.slug));
  const missing = jobTech.filter((t) => !candidateSlugs.has(t.slug));

  return {
    ratio: matched.length / jobTech.length,
    matched: matched.map((t) => t.name),
    missing: missing.map((t) => t.name),
    totalRequired: jobTech.length,
  };
}

const YEARS_PATTERN = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/i;

/** Extracts the first "N years"/"N+ years" figure found in free text, or null. */
function extractYears(text) {
  const match = YEARS_PATTERN.exec(text || "");
  return match ? parseFloat(match[1]) : null;
}

/**
 * Ordered seniority ladder (lowest to highest). Kept as one ranked list so
 * both the experience component (years/keyword fallback) and the dedicated
 * seniority component can share a single source of truth for "which level
 * is higher than which".
 */
const SENIORITY_LEVELS = [
  { rank: 1, label: "Intern", keywords: ["intern"] },
  { rank: 2, label: "Entry-Level", keywords: ["entry-level", "entry level"] },
  { rank: 3, label: "Junior", keywords: ["junior"] },
  { rank: 4, label: "Associate", keywords: ["associate"] },
  { rank: 5, label: "Mid-Level", keywords: ["mid-level", "mid level"] },
  { rank: 6, label: "Senior", keywords: ["senior"] },
  { rank: 7, label: "Lead", keywords: ["lead"] },
  { rank: 8, label: "Principal", keywords: ["principal"] },
  { rank: 9, label: "Staff", keywords: ["staff"] },
  { rank: 10, label: "Manager", keywords: ["manager"] },
  { rank: 11, label: "Director", keywords: ["director"] },
];

const SENIORITY_KEYWORDS = SENIORITY_LEVELS.flatMap((level) => level.keywords);

/** Which of SENIORITY_KEYWORDS appear in a piece of text. */
function detectSeniorityKeywords(text) {
  const lower = (text || "").toLowerCase();
  return SENIORITY_KEYWORDS.filter((kw) => lower.includes(kw));
}

/** Highest seniority rung mentioned in a piece of text, or null if none found. */
function detectHighestSeniorityLevel(text) {
  const lower = (text || "").toLowerCase();
  let highest = null;
  for (const level of SENIORITY_LEVELS) {
    if (level.keywords.some((kw) => lower.includes(kw))) {
      if (!highest || level.rank > highest.rank) highest = level;
    }
  }
  return highest;
}

/**
 * Experience component: prefers comparing an explicit "N years" figure from
 * the job description against one from the candidate's `experience` field.
 * Falls back to seniority-keyword overlap (junior/mid/senior/lead/etc.)
 * when the job description doesn't state a specific number of years.
 */
function computeExperienceMatch({ experience, jobDescription }) {
  const requiredYears = extractYears(jobDescription);
  const candidateYears = extractYears(experience);

  if (requiredYears !== null && candidateYears !== null) {
    const ratio = requiredYears <= 0 ? 1 : clamp01(candidateYears / requiredYears);
    return {
      ratio,
      requiredYears,
      candidateYears,
      basis: "years",
    };
  }

  const jobSeniority = detectSeniorityKeywords(jobDescription);
  const candidateSeniority = detectSeniorityKeywords(experience);

  if (jobSeniority.length > 0) {
    const matchedSeniority = jobSeniority.filter((kw) => candidateSeniority.includes(kw));
    return {
      ratio: matchedSeniority.length / jobSeniority.length,
      requiredYears,
      candidateYears,
      basis: "seniority-keywords",
    };
  }

  // Neither an explicit years figure nor a seniority keyword was found in
  // the job description — give partial, neutral credit rather than
  // penalizing the candidate for a signal the job posting never gave.
  return {
    ratio: candidateYears !== null || candidateSeniority.length > 0 ? 0.75 : 0.5,
    requiredYears,
    candidateYears,
    basis: "neutral",
  };
}

const EDUCATION_LEVELS = [
  { level: 1, keywords: ["high school", "ged", "secondary school"] },
  { level: 2, keywords: ["associate degree", "associate's degree", "diploma"] },
  { level: 3, keywords: ["bachelor", "b.sc", "bsc", "b.a.", "undergraduate degree", "bs degree", "ba degree"] },
  { level: 4, keywords: ["master", "m.sc", "msc", "mba", "m.a.", "graduate degree"] },
  { level: 5, keywords: ["phd", "ph.d", "doctorate", "doctoral"] },
];

/** Highest education level keyword found in text, or 0 if none detected. */
function detectEducationLevel(text) {
  const lower = (text || "").toLowerCase();
  let highest = 0;
  for (const { level, keywords } of EDUCATION_LEVELS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      highest = Math.max(highest, level);
    }
  }
  return highest;
}

/**
 * Education component: compares the candidate's stated education level
 * against any education level mentioned in the job description, using a
 * simple degree-level hierarchy. If the job description doesn't mention
 * education at all, the candidate isn't penalized for it.
 */
function computeEducationMatch({ education, jobDescription }) {
  const jobLevel = detectEducationLevel(jobDescription);
  const candidateLevel = detectEducationLevel(education);

  if (jobLevel === 0) {
    return { ratio: 1, jobLevel, candidateLevel };
  }

  if (candidateLevel >= jobLevel) {
    return { ratio: 1, jobLevel, candidateLevel };
  }

  const gap = jobLevel - candidateLevel;
  const ratio = Math.max(0, 1 - gap * 0.25);
  return { ratio, jobLevel, candidateLevel };
}

/**
 * Curated project/domain-scope vocabulary. Used to detect whether the kind
 * of project work a job description describes (platform scale, domain,
 * delivery style) shows up anywhere in the candidate's resume/skills —
 * distinct from named technologies (computeTechnologyMatch) and from
 * single-word ATS keywords (computeKeywordsMatch).
 */
const PROJECT_DOMAIN_TERMS = [
  "microservices", "monolith", "distributed system", "distributed systems",
  "scalable", "high-availability", "high availability", "real-time", "realtime",
  "platform", "architecture", "prototype", "mvp", "greenfield", "legacy",
  "migration", "refactor", "modernization", "integration", "automation",
  "data pipeline", "etl", "api gateway", "dashboard", "mobile app", "web app",
  "e-commerce", "ecommerce", "marketplace", "saas", "b2b", "b2c", "fintech",
  "healthtech", "edtech", "cross-functional", "self-serve", "internal tool",
  "customer-facing",
];

/**
 * Projects/domain-scope component: compares the project/domain vocabulary
 * the job description actually uses against the candidate's resume+skills
 * text. If the job description doesn't reference any of this vocabulary,
 * the candidate isn't penalized for a signal the posting never gave.
 */
function computeProjectsMatch({ resumeText, skills, jobDescription }) {
  const jobLower = jobDescription.toLowerCase();
  const candidateLower = `${resumeText}\n${skills}`.toLowerCase();

  const relevantTerms = PROJECT_DOMAIN_TERMS.filter((term) => jobLower.includes(term));
  if (relevantTerms.length === 0) {
    return { ratio: 1, matched: [], missing: [], totalRelevant: 0 };
  }

  const matched = relevantTerms.filter((term) => candidateLower.includes(term));
  const missing = relevantTerms.filter((term) => !candidateLower.includes(term));

  return {
    ratio: matched.length / relevantTerms.length,
    matched: matched.map(toDisplayCase),
    missing: missing.map(toDisplayCase),
    totalRelevant: relevantTerms.length,
  };
}

/**
 * Curated ownership/action-verb vocabulary used to gauge whether a resume
 * demonstrates the kind of responsibility (leading, designing, owning,
 * mentoring, delivering) the job description is asking for — separate from
 * skills/technology, since two candidates can share a tech stack but very
 * different levels of ownership.
 */
const RESPONSIBILITY_VERBS = [
  "led", "lead", "managed", "mentored", "designed", "architected",
  "collaborated", "owned", "delivered", "optimized", "maintained", "deployed",
  "reviewed", "coordinated", "implemented", "built", "developed", "launched",
  "drove", "spearheaded", "planned", "executed", "supervised", "trained",
  "presented", "negotiated", "budgeted", "hired", "onboarded", "automated",
  "scaled", "improved", "reduced", "increased",
];

/**
 * Responsibilities component: how much of the ownership/action-verb
 * vocabulary the job description uses is echoed anywhere in the resume. If
 * the job description doesn't use any of this vocabulary, the candidate
 * isn't penalized.
 */
function computeResponsibilitiesMatch({ resumeText, jobDescription }) {
  const jobLower = jobDescription.toLowerCase();
  const resumeLower = resumeText.toLowerCase();

  const relevantVerbs = RESPONSIBILITY_VERBS.filter((verb) => jobLower.includes(verb));
  if (relevantVerbs.length === 0) {
    return { ratio: 1, matched: [], missing: [], totalRelevant: 0 };
  }

  const matched = relevantVerbs.filter((verb) => resumeLower.includes(verb));
  const missing = relevantVerbs.filter((verb) => !resumeLower.includes(verb));

  return {
    ratio: matched.length / relevantVerbs.length,
    matched: matched.map(toDisplayCase),
    missing: missing.map(toDisplayCase),
    totalRelevant: relevantVerbs.length,
  };
}

/**
 * Seniority component: a dedicated read on seniority language (as opposed
 * to computeExperienceMatch, which prefers a literal "N years" figure and
 * only falls back to seniority keywords when no years figure exists). This
 * always runs so seniority can be reported and explained on its own,
 * regardless of which basis experience-matching used.
 */
function computeSeniorityMatch({ resumeText, experience, jobDescription }) {
  const candidateText = `${experience}\n${resumeText}`;

  const jobKeywords = detectSeniorityKeywords(jobDescription);
  const candidateKeywords = detectSeniorityKeywords(candidateText);
  const jobLevel = detectHighestSeniorityLevel(jobDescription);
  const candidateLevel = detectHighestSeniorityLevel(candidateText);

  if (jobKeywords.length === 0) {
    // Job description doesn't name a seniority band — neutral, not penalized.
    return { ratio: 0.75, matched: [], missing: [], jobLevel, candidateLevel };
  }

  const matched = jobKeywords.filter((kw) => candidateKeywords.includes(kw));
  const missing = jobKeywords.filter((kw) => !candidateKeywords.includes(kw));
  let ratio = matched.length / jobKeywords.length;

  if (jobLevel && candidateLevel) {
    if (candidateLevel.rank >= jobLevel.rank) {
      ratio = Math.max(ratio, 0.9);
    } else if (jobLevel.rank - candidateLevel.rank >= 2) {
      ratio = Math.min(ratio, 0.4);
    }
  }

  return {
    ratio: clamp01(ratio),
    matched: dedupeCaseInsensitive(matched.map(toDisplayCase)),
    missing: dedupeCaseInsensitive(missing.map(toDisplayCase)),
    jobLevel,
    candidateLevel,
  };
}

/**
 * Keywords/ATS-overlap component: a broader, whole-document keyword
 * overlap (beyond the explicit `skills` field matching in
 * computeSkillsMatch) — the same general signal an ATS keyword scan would
 * use. Reported as its own category so a candidate can see general
 * vocabulary alignment distinct from named skills/technologies.
 */
function computeKeywordsMatch({ resumeText, skills, jobDescription }) {
  const candidateKeywords = extractKeywordSet(`${resumeText}\n${skills}`);
  const jobKeywords = extractKeywordSet(jobDescription);
  const ratio = keywordOverlapRatio(candidateKeywords, jobKeywords);

  const sortedJobKeywords = Array.from(jobKeywords).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const matched = sortedJobKeywords.filter((word) => candidateKeywords.has(word)).slice(0, 10);
  const missing = sortedJobKeywords.filter((word) => !candidateKeywords.has(word)).slice(0, 10);

  return {
    ratio,
    matched: matched.map(toDisplayCase),
    missing: missing.map(toDisplayCase),
  };
}

const WEIGHTS = {
  skills: 0.28,
  technology: 0.14,
  experience: 0.18,
  education: 0.08,
  projects: 0.1,
  responsibilities: 0.1,
  seniority: 0.07,
  keywords: 0.05,
};

/** Rounds a 0–1 ratio into a 0–100 whole-number percentage. */
function toPercent(ratio) {
  return Math.round(clamp01(ratio) * 100);
}

/**
 * Builds a short, specific (never generic/boilerplate) sentence describing
 * one analysis category, referencing actual matched/missing items and
 * counts so two different resumes never read like the same template.
 */
function describeCategory(name, percent, matched, missing, extraContext = "") {
  const matchedSample = matched.slice(0, 4).join(", ");
  const missingSample = missing.slice(0, 4).join(", ");

  if (percent >= 85) {
    return matchedSample
      ? `${name}: ${percent}% aligned — strong overlap on ${matchedSample}${extraContext ? `; ${extraContext}` : ""}.`
      : `${name}: ${percent}% aligned${extraContext ? ` — ${extraContext}` : "."}`;
  }
  if (percent >= 60) {
    return `${name}: ${percent}% aligned. ${matchedSample ? `Covers ${matchedSample}.` : ""}${
      missingSample ? ` Still missing ${missingSample}.` : ""
    }${extraContext ? ` ${extraContext}` : ""}`.trim();
  }
  return `${name}: only ${percent}% aligned${missingSample ? ` — missing ${missingSample}` : ""}.${
    extraContext ? ` ${extraContext}` : ""
  }`;
}

/**
 * The core, deterministic Job Match Score algorithm. No AI/LLM call is
 * involved in producing `score`, `matchedSkills`, `missingSkills`, or any of
 * the deeper analysis fields — this function alone is the source of truth.
 *
 * @param {{ resumeText: string, jobDescription: string, skills: string, experience: string, education: string }} input
 */
function calculateMatchScore({ resumeText, jobDescription, skills, experience, education }) {
  const jobDescriptionLower = jobDescription.toLowerCase();
  const skillPhrases = tokenizePhraseList(skills);

  const skillsResult = computeSkillsMatch({ skillPhrases, jobDescriptionLower, resumeText, skills, jobDescription });
  const technologyResult = computeTechnologyMatch({ resumeText, skills, jobDescription });
  const experienceResult = computeExperienceMatch({ experience, jobDescription });
  const educationResult = computeEducationMatch({ education, jobDescription });
  const projectsResult = computeProjectsMatch({ resumeText, skills, jobDescription });
  const responsibilitiesResult = computeResponsibilitiesMatch({ resumeText, jobDescription });
  const seniorityResult = computeSeniorityMatch({ resumeText, experience, jobDescription });
  const keywordsResult = computeKeywordsMatch({ resumeText, skills, jobDescription });

  const weightedScore =
    skillsResult.ratio * WEIGHTS.skills +
    technologyResult.ratio * WEIGHTS.technology +
    experienceResult.ratio * WEIGHTS.experience +
    educationResult.ratio * WEIGHTS.education +
    projectsResult.ratio * WEIGHTS.projects +
    responsibilitiesResult.ratio * WEIGHTS.responsibilities +
    seniorityResult.ratio * WEIGHTS.seniority +
    keywordsResult.ratio * WEIGHTS.keywords;

  const score = Math.max(0, Math.min(100, Math.round(weightedScore * 100)));

  // Kept exactly as before: the union of skills-field + technology matches,
  // for backward compatibility with every existing consumer of this field.
  const matchedSkills = dedupeCaseInsensitive([...technologyResult.matched, ...skillsResult.matched]);
  const missingSkills = dedupeCaseInsensitive([...technologyResult.missing, ...skillsResult.missing]);

  /* -------------------------- per-category analysis -------------------- */

  const experienceContext =
    experienceResult.basis === "years"
      ? `requires ~${experienceResult.requiredYears} yrs, candidate has ${experienceResult.candidateYears ?? "an unspecified amount of"} yrs`
      : experienceResult.basis === "seniority-keywords"
        ? "based on seniority language rather than an explicit years figure"
        : "job posting didn't state a specific years/seniority bar";

  const seniorityContext =
    seniorityResult.jobLevel && seniorityResult.candidateLevel
      ? `role reads as ${seniorityResult.jobLevel.label}, resume reads as ${seniorityResult.candidateLevel.label}`
      : seniorityResult.jobLevel
        ? `role reads as ${seniorityResult.jobLevel.label}; resume doesn't clearly state a level`
        : "";

  const analysis = {
    skills: {
      label: "Skills",
      weight: `${Math.round(WEIGHTS.skills * 100)}%`,
      percentage: toPercent(skillsResult.ratio),
      matched: skillsResult.matched,
      missing: skillsResult.missing,
      note: describeCategory("Skills", toPercent(skillsResult.ratio), skillsResult.matched, skillsResult.missing),
    },
    technology: {
      label: "Technology",
      weight: `${Math.round(WEIGHTS.technology * 100)}%`,
      percentage: toPercent(technologyResult.ratio),
      matched: technologyResult.matched,
      missing: technologyResult.missing,
      note: describeCategory(
        "Technology",
        toPercent(technologyResult.ratio),
        technologyResult.matched,
        technologyResult.missing,
      ),
    },
    experience: {
      label: "Experience",
      weight: `${Math.round(WEIGHTS.experience * 100)}%`,
      percentage: toPercent(experienceResult.ratio),
      requiredYears: experienceResult.requiredYears,
      candidateYears: experienceResult.candidateYears,
      basis: experienceResult.basis,
      note: `Experience: ${toPercent(experienceResult.ratio)}% aligned (${experienceContext}).`,
    },
    education: {
      label: "Education",
      weight: `${Math.round(WEIGHTS.education * 100)}%`,
      percentage: toPercent(educationResult.ratio),
      jobLevel: educationResult.jobLevel,
      candidateLevel: educationResult.candidateLevel,
      note:
        educationResult.jobLevel === 0
          ? "Education: job posting doesn't specify a required level, so this wasn't held against the candidate."
          : `Education: ${toPercent(educationResult.ratio)}% aligned (role implies level ${educationResult.jobLevel}, resume implies level ${educationResult.candidateLevel}).`,
    },
    projects: {
      label: "Projects & Domain Scope",
      weight: `${Math.round(WEIGHTS.projects * 100)}%`,
      percentage: toPercent(projectsResult.ratio),
      matched: projectsResult.matched,
      missing: projectsResult.missing,
      note:
        projectsResult.totalRelevant === 0
          ? "Projects & Domain Scope: job description didn't call out specific domain/project vocabulary, so nothing was held against the candidate here."
          : describeCategory(
              "Projects & Domain Scope",
              toPercent(projectsResult.ratio),
              projectsResult.matched,
              projectsResult.missing,
            ),
    },
    responsibilities: {
      label: "Responsibilities & Ownership",
      weight: `${Math.round(WEIGHTS.responsibilities * 100)}%`,
      percentage: toPercent(responsibilitiesResult.ratio),
      matched: responsibilitiesResult.matched,
      missing: responsibilitiesResult.missing,
      note:
        responsibilitiesResult.totalRelevant === 0
          ? "Responsibilities & Ownership: job description didn't emphasize specific ownership verbs, so nothing was held against the candidate here."
          : describeCategory(
              "Responsibilities & Ownership",
              toPercent(responsibilitiesResult.ratio),
              responsibilitiesResult.matched,
              responsibilitiesResult.missing,
            ),
    },
    seniority: {
      label: "Seniority Level",
      weight: `${Math.round(WEIGHTS.seniority * 100)}%`,
      percentage: toPercent(seniorityResult.ratio),
      jobLevel: seniorityResult.jobLevel?.label ?? null,
      candidateLevel: seniorityResult.candidateLevel?.label ?? null,
      note: seniorityContext
        ? `Seniority Level: ${toPercent(seniorityResult.ratio)}% aligned (${seniorityContext}).`
        : `Seniority Level: ${toPercent(seniorityResult.ratio)}% aligned — job posting doesn't state a clear seniority band.`,
    },
    keywords: {
      label: "Keywords / ATS Overlap",
      weight: `${Math.round(WEIGHTS.keywords * 100)}%`,
      percentage: toPercent(keywordsResult.ratio),
      matched: keywordsResult.matched,
      missing: keywordsResult.missing,
      note: describeCategory(
        "Keywords / ATS Overlap",
        toPercent(keywordsResult.ratio),
        keywordsResult.matched,
        keywordsResult.missing,
      ),
    },
  };

  /* ------------------- missing-skill point-impact estimate -------------- */

  const skillImpactPerItem =
    skillsResult.totalListed > 0 ? Math.round((WEIGHTS.skills * 100 * 0.7) / skillsResult.totalListed) : 0;
  const techImpactPerItem =
    technologyResult.totalRequired > 0 ? Math.round((WEIGHTS.technology * 100) / technologyResult.totalRequired) : 0;

  const missingSkillsImpact = [
    ...skillsResult.missing.map((skill) => ({
      skill,
      category: "Skill",
      impactPoints: Math.max(1, skillImpactPerItem),
      reason: "Listed as a required skill in the job description but not found in your resume or skills list.",
    })),
    ...technologyResult.missing.map((tech) => ({
      skill: tech,
      category: "Technology",
      impactPoints: Math.max(1, techImpactPerItem),
      reason: "Mentioned in the job description but not detected anywhere in your resume or skills.",
    })),
  ]
    .sort((a, b) => b.impactPoints - a.impactPoints)
    .slice(0, 12);

  /* --------------------------- improvement plan -------------------------- */

  const categoryGaps = [
    {
      area: "Skills",
      ratio: skillsResult.ratio,
      weight: WEIGHTS.skills,
      suggestion: skillsResult.missing.length
        ? `Add or surface these listed-but-missing skills if you genuinely have them: ${skillsResult.missing.slice(0, 6).join(", ")}.`
        : "Mirror the job description's exact skill phrasing more closely to strengthen keyword alignment.",
    },
    {
      area: "Technology",
      ratio: technologyResult.ratio,
      weight: WEIGHTS.technology,
      suggestion: technologyResult.missing.length
        ? `Call out hands-on experience with: ${technologyResult.missing.slice(0, 6).join(", ")} (only if true — don't fabricate).`
        : "Your named tech stack already lines up well with this role.",
    },
    {
      area: "Experience",
      ratio: experienceResult.ratio,
      weight: WEIGHTS.experience,
      suggestion:
        experienceResult.basis === "years" && experienceResult.candidateYears < experienceResult.requiredYears
          ? `State your years of experience explicitly and emphasize depth/impact to help close the gap to the ${experienceResult.requiredYears}-year bar this role sets.`
          : "Quantify the scope and impact of your experience (team size, metrics, outcomes) so it reads at the level this role expects.",
    },
    {
      area: "Education",
      ratio: educationResult.ratio,
      weight: WEIGHTS.education,
      suggestion:
        educationResult.jobLevel > educationResult.candidateLevel
          ? "Highlight equivalent certifications, bootcamps, or demonstrable experience to offset the formal education gap."
          : "Education already meets what this posting expects.",
    },
    {
      area: "Projects & Domain Scope",
      ratio: projectsResult.ratio,
      weight: WEIGHTS.projects,
      suggestion: projectsResult.missing.length
        ? `Describe a project in terms this role cares about: ${projectsResult.missing.slice(0, 5).join(", ")}.`
        : "Your project descriptions already speak this role's domain language.",
    },
    {
      area: "Responsibilities & Ownership",
      ratio: responsibilitiesResult.ratio,
      weight: WEIGHTS.responsibilities,
      suggestion: responsibilitiesResult.missing.length
        ? `Rewrite bullet points using stronger ownership verbs this role expects: ${responsibilitiesResult.missing.slice(0, 5).join(", ")}.`
        : "Your resume already demonstrates the level of ownership this role is asking for.",
    },
    {
      area: "Seniority Level",
      ratio: seniorityResult.ratio,
      weight: WEIGHTS.seniority,
      suggestion:
        seniorityResult.jobLevel && seniorityResult.candidateLevel && seniorityResult.candidateLevel.rank < seniorityResult.jobLevel.rank
          ? `State your seniority explicitly (e.g. "${seniorityResult.jobLevel.label}") if your scope of work actually supports it, or target roles closer to ${seniorityResult.candidateLevel.label}.`
          : "Your stated seniority already matches what this role is asking for.",
    },
    {
      area: "Keywords / ATS Overlap",
      ratio: keywordsResult.ratio,
      weight: WEIGHTS.keywords,
      suggestion: keywordsResult.missing.length
        ? `Work in more of this job's own vocabulary where accurate: ${keywordsResult.missing.slice(0, 6).join(", ")}.`
        : "Your resume's language already overlaps well with this job description for ATS parsing.",
    },
  ];

  const improvementPlan = categoryGaps
    .filter((c) => c.ratio < 0.9)
    .map((c) => {
      const impactPoints = Math.max(1, Math.round((1 - c.ratio) * c.weight * 100));
      const priority = impactPoints >= 12 ? "High" : impactPoints >= 5 ? "Medium" : "Low";
      return { area: c.area, priority, impactPoints, suggestion: c.suggestion };
    })
    .sort((a, b) => b.impactPoints - a.impactPoints);

  const improvements = improvementPlan.length
    ? improvementPlan.map((item) => `[${item.priority} impact, ~${item.impactPoints} pts] ${item.suggestion}`)
    : [
        "Your profile is well aligned with this job — consider tailoring your resume's wording to mirror the job description's exact terms for ATS purposes.",
      ];

  /* ------------------------------ strengths ------------------------------ */

  const strengths = categoryGaps
    .filter((c) => c.ratio >= 0.75)
    .sort((a, b) => b.ratio - a.ratio)
    .map((c) => analysis[c.area === "Keywords / ATS Overlap" ? "keywords" : c.area === "Projects & Domain Scope" ? "projects" : c.area === "Responsibilities & Ownership" ? "responsibilities" : c.area === "Seniority Level" ? "seniority" : c.area.toLowerCase()].note);

  const dedupedStrengths = dedupeCaseInsensitive(strengths.length ? strengths : ["You meet the baseline requirements described in the job posting."]);

  /* -------------------------------- badges -------------------------------- */

  const badges = [];
  if (score >= 85) badges.push({ label: "🏆 Excellent Match", tone: "success" });
  else if (score >= 70) badges.push({ label: "✅ Strong Match", tone: "success" });
  else if (score >= 50) badges.push({ label: "⚠️ Partial Match", tone: "warning" });
  else badges.push({ label: "🔴 Weak Match", tone: "danger" });

  if (skillsResult.ratio >= 0.8) badges.push({ label: "🧠 Skills Aligned", tone: "success" });
  if (technologyResult.missing.length > 0) badges.push({ label: `🧩 ${technologyResult.missing.length} Tech Gap(s)`, tone: "warning" });
  if (seniorityResult.jobLevel && seniorityResult.candidateLevel && seniorityResult.candidateLevel.rank >= seniorityResult.jobLevel.rank) {
    badges.push({ label: "🎯 Seniority-Ready", tone: "success" });
  }
  if (educationResult.jobLevel > educationResult.candidateLevel) badges.push({ label: "📚 Education Gap", tone: "warning" });
  if (responsibilitiesResult.ratio >= 0.75 && responsibilitiesResult.totalRelevant > 0) {
    badges.push({ label: "🏗️ Ownership Demonstrated", tone: "success" });
  }

  /* --------------------------- interview readiness ------------------------ */

  const readinessRatio =
    (experienceResult.ratio + seniorityResult.ratio + responsibilitiesResult.ratio + skillsResult.ratio) / 4;
  const readinessScore = toPercent(readinessRatio);
  const readinessLevel = readinessScore >= 75 ? "High" : readinessScore >= 50 ? "Medium" : "Low";

  const readinessFocusAreas = improvementPlan.slice(0, 3).map((item) => item.area);

  const interviewReadiness = {
    level: readinessLevel,
    score: readinessScore,
    summary:
      readinessLevel === "High"
        ? "Strong footing for this interview — your experience, seniority, and ownership signals line up with what the role expects. Prepare specific, quantified stories for your top projects."
        : readinessLevel === "Medium"
          ? "You can credibly interview for this role, but be ready to directly address the gaps below — have a clear, honest narrative prepared for each."
          : "Treat this as a stretch application — go in ready to explain how you'd ramp up quickly on the gaps below, and lead with your closest transferable wins.",
    focusAreas: readinessFocusAreas.length ? readinessFocusAreas : ["General role-specific preparation"],
  };

  /* ------------------------- resume recommendations ----------------------- */

  const resumeRecommendations = [];
  if (technologyResult.missing.length > 0) {
    resumeRecommendations.push(
      `Add a visible line for each of these if you have real hands-on experience: ${technologyResult.missing.slice(0, 5).join(", ")}.`,
    );
  }
  if (skillsResult.missing.length > 0) {
    resumeRecommendations.push(
      `Re-word your skills section to explicitly include: ${skillsResult.missing.slice(0, 5).join(", ")} (only where accurate).`,
    );
  }
  if (experienceResult.basis === "years" && experienceResult.candidateYears === null) {
    resumeRecommendations.push(`State your total years of experience explicitly — this role asks for ~${experienceResult.requiredYears} years and your resume doesn't state a number.`);
  }
  if (responsibilitiesResult.missing.length > 0) {
    resumeRecommendations.push(
      `Swap in stronger ownership verbs in your bullet points, e.g. "${responsibilitiesResult.missing.slice(0, 3).join('", "')}", to match how this role describes the work.`,
    );
  }
  if (projectsResult.missing.length > 0) {
    resumeRecommendations.push(
      `Reframe at least one project bullet around: ${projectsResult.missing.slice(0, 3).join(", ")} — the scope language this posting uses.`,
    );
  }
  if (educationResult.jobLevel > educationResult.candidateLevel) {
    resumeRecommendations.push("Add any certifications, bootcamps, or equivalent training near your education section to soften the formal-degree gap.");
  }
  if (resumeRecommendations.length === 0) {
    resumeRecommendations.push("Your resume is already well-tailored to this posting — focus polish on quantifying results (numbers, scale, outcomes) rather than adding new keywords.");
  }

  /* ------------------------------ fit summary ----------------------------- */

  const topStrengthArea = categoryGaps.slice().sort((a, b) => b.ratio - a.ratio)[0];
  const topGapArea = improvementPlan[0];

  let fitSummary;
  if (score >= 80) {
    fitSummary = `This is a strong match: ${topStrengthArea.area.toLowerCase()} alignment is a real asset here${
      topGapArea ? `, and the only meaningful gap is ${topGapArea.area.toLowerCase()}, worth a quick fix before applying` : ""
    }. A recruiter scanning this resume against this posting would see clear, credible overlap rather than a stretch application.`;
  } else if (score >= 55) {
    fitSummary = `This is a workable but not automatic match: ${topStrengthArea.area.toLowerCase()} carries the application, while ${
      topGapArea ? topGapArea.area.toLowerCase() : "a few areas"
    } will likely draw recruiter questions. Addressing the top items in the improvement plan below meaningfully changes how this resume reads for this specific role.`;
  } else {
    fitSummary = `This is currently a stretch match — the core signals this posting is screening for (${
      topGapArea ? topGapArea.area.toLowerCase() : "several key areas"
    } especially) aren't yet clearly demonstrated in the resume. It's not disqualifying, but expect to actively address these gaps in a cover letter or interview rather than relying on the resume alone.`;
  }

  return {
    score,
    matchedSkills,
    missingSkills,
    strengths: dedupedStrengths,
    improvements,
    breakdown: {
      skillsMatch: toPercent(skillsResult.ratio),
      technologyMatch: toPercent(technologyResult.ratio),
      experienceMatch: toPercent(experienceResult.ratio),
      educationMatch: toPercent(educationResult.ratio),
      projectsMatch: toPercent(projectsResult.ratio),
      responsibilitiesMatch: toPercent(responsibilitiesResult.ratio),
      seniorityMatch: toPercent(seniorityResult.ratio),
      keywordsMatch: toPercent(keywordsResult.ratio),
    },
    analysis,
    missingSkillsImpact,
    improvementPlan,
    badges,
    interviewReadiness,
    resumeRecommendations,
    fitSummary,
  };
}

/* ---------------------------------------------------------------------- */
/* Optional AI enhancement layer (premium write-up around the final score) */
/* ---------------------------------------------------------------------- */

/**
 * Best-effort call into the shared aiService, used ONLY to turn the
 * already-final deterministic analysis into a polished, well-formatted
 * write-up. Returns null (never throws) if the shared AI architecture
 * can't be loaded or fails for any reason — callers treat a null return as
 * "fall back to the local write-up". The score itself is passed in as
 * context and is never altered by this.
 */
async function tryRunSharedAIFeature({ user, input, matchResult, usage }) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    const analysisLines = Object.values(matchResult.analysis)
      .map((cat) => `- ${cat.label} (${cat.weight} weight): ${cat.percentage}% — ${cat.note}`)
      .join("\n");

    const missingImpactLines = matchResult.missingSkillsImpact
      .map((m) => `- ${m.skill} [${m.category}] — ~${m.impactPoints} pts if added`)
      .join("\n") || "none";

    const improvementLines = matchResult.improvementPlan
      .map((i) => `- (${i.priority}, ~${i.impactPoints} pts) ${i.area}: ${i.suggestion}`)
      .join("\n") || "none — profile is well aligned";

    const badgeLine = matchResult.badges.map((b) => b.label).join(", ");

    const combinedPrompt =
      `Calculated overall match score (already final, do not change): ${matchResult.score}/100\n\n` +
      `Badges already assigned: ${badgeLine}\n\n` +
      `Per-category analysis (already final):\n${analysisLines}\n\n` +
      `Matched skills/technologies: ${matchResult.matchedSkills.join(", ") || "none detected"}\n\n` +
      `Missing skills/technologies with point impact if added:\n${missingImpactLines}\n\n` +
      `Prioritized improvement plan (already final, ordered by impact):\n${improvementLines}\n\n` +
      `Interview readiness (already computed): ${matchResult.interviewReadiness.level} (${matchResult.interviewReadiness.score}/100), focus areas: ${matchResult.interviewReadiness.focusAreas.join(", ")}\n\n` +
      `Resume recommendations (already computed):\n- ${matchResult.resumeRecommendations.join("\n- ")}\n\n` +
      `Fit summary (already computed, elaborate on this, don't contradict it): ${matchResult.fitSummary}\n\n` +
      `Resume text: ${input.resumeText}\n\n` +
      `Job description: ${input.jobDescription}\n\n` +
      `Candidate skills: ${input.skills}\n\n` +
      `Candidate experience: ${input.experience}\n\n` +
      `Candidate education: ${input.education}`;

    const result = await runAIFeature({
      feature: FEATURE,
      user,
      prompt: combinedPrompt,
      options: {
        supportedFeatures: [FEATURE],
        maxLength: MAX_COMBINED_PROMPT_LENGTH,
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // History is saved once, uniformly, by this controller below —
        // regardless of whether the AI or local-fallback write-up was
        // used — so aiService's own internal save is disabled here.
        saveToHistory: false,
        plan: usage?.plan,
        usageRemaining: usage?.remaining,
      },
    });

    if (result && result.success && result.data && result.data.result) {
      return result;
    }
    return null;
  } catch {
    // Shared AI architecture unavailable/unwired/erroring — caller falls back.
    return null;
  }
}

/**
 * Deterministic, rule-based, richly-formatted write-up used only when the
 * shared AI provider is unavailable. Built entirely from the
 * already-calculated analysis — no external call, never fails, and reads
 * like a premium AI recruiter's notes rather than a generic keyword report.
 */
function buildFallbackExplanation(matchResult) {
  const { score, badges, analysis, missingSkillsImpact, improvementPlan, strengths, interviewReadiness, resumeRecommendations, fitSummary } = matchResult;

  const badgeLine = badges.map((b) => b.label).join("  ");

  const overview = `## Job Match Analysis\n${badgeLine}\n\n**Overall Match Score: ${score}/100**`;

  const breakdownLines = Object.values(analysis)
    .map((cat) => `- **${cat.label}** (${cat.weight} weight) — ${cat.percentage}%: ${cat.note}`)
    .join("\n");
  const breakdownSection = `### 📊 Score Breakdown\n${breakdownLines}`;

  const strengthsSection = `### ✅ Strengths\n${strengths.map((s) => `- ${s}`).join("\n")}`;

  const improvementsSection = improvementPlan.length
    ? `### ⚠️ Areas to Improve (highest impact first)\n${improvementPlan
        .map((i) => `- **[${i.priority} — ~${i.impactPoints} pts]** ${i.area}: ${i.suggestion}`)
        .join("\n")}`
    : `### ⚠️ Areas to Improve\n- No major gaps found — this profile is already well aligned with the role.`;

  const missingSection = missingSkillsImpact.length
    ? `### 🧩 Missing Skills & Impact\n${missingSkillsImpact
        .map((m) => `- **${m.skill}** (${m.category}, ~${m.impactPoints} pts): ${m.reason}`)
        .join("\n")}`
    : `### 🧩 Missing Skills & Impact\n- No significant missing skills or technologies detected.`;

  const readinessSection =
    `### 🎤 Interview Readiness — ${interviewReadiness.level} (${interviewReadiness.score}/100)\n` +
    `${interviewReadiness.summary}\n` +
    `Focus areas: ${interviewReadiness.focusAreas.join(", ")}.`;

  const recommendationsSection = `### 📄 Resume Recommendations\n${resumeRecommendations.map((r) => `- ${r}`).join("\n")}`;

  const fitSection = `### 🧭 Why This Fit Works (or Doesn't)\n${fitSummary}`;

  return [overview, breakdownSection, strengthsSection, improvementsSection, missingSection, readinessSection, recommendationsSection, fitSection].join(
    "\n\n",
  );
}

/**
 * Best-effort history save via the shared historyService. Never throws —
 * failures are logged and swallowed so they can't break the user-facing
 * response, matching the pattern already used inside aiService.js.
 */
async function saveHistoryBestEffort({ user, promptText, resultText, provider, fallback, metadata }) {
  try {
    const historyModule = await import("../../../lib/ai/services/historyService.js");
    const saveHistory = historyModule.saveHistory || historyModule.default?.saveHistory;
    if (typeof saveHistory !== "function") return;

    await saveHistory({
      user,
      feature: FEATURE,
      prompt: promptText,
      response: resultText,
      provider,
      metadata: { fallback, ...metadata },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[jobMatchScore] Failed to save AI history:", err?.message || err);
  }
}

/**
 * POST /calculate
 * Requires auth + usage-limit check (wired in jobMatchScore.routes.js).
 * Body: { resumeText, jobDescription, skills, experience, education }
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function calculateJobMatchScore(req, res, next) {
  try {
    const body = req.body || {};

    const resumeText = typeof body.resumeText === "string" ? body.resumeText : null;
    const jobDescription = typeof body.jobDescription === "string" ? body.jobDescription : null;
    const experience = typeof body.experience === "string" ? body.experience : null;
    const education = typeof body.education === "string" ? body.education : null;
    const normalizedSkills = normalizeSkillsInput(body.skills);

    if (resumeText === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "resumeText is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["RESUME_TEXT_REQUIRED"],
          }),
        );
    }

    if (jobDescription === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "jobDescription is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["JOB_DESCRIPTION_REQUIRED"],
          }),
        );
    }

    if (normalizedSkills === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "skills is required and must be a non-empty string or array of strings.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["SKILLS_REQUIRED"],
          }),
        );
    }

    if (experience === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "experience is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["EXPERIENCE_REQUIRED"],
          }),
        );
    }

    if (education === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "education is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["EDUCATION_REQUIRED"],
          }),
        );
    }

    const sanitizedResumeText = sanitizeText(resumeText);
    const sanitizedJobDescription = sanitizeText(jobDescription);
    const sanitizedSkills = normalizedSkills; // already sanitized in normalizeSkillsInput
    const sanitizedExperience = sanitizeText(experience);
    const sanitizedEducation = sanitizeText(education);

    const fieldChecks = [
      {
        value: sanitizedResumeText,
        min: MIN_RESUME_TEXT_LENGTH,
        max: MAX_RESUME_TEXT_LENGTH,
        name: "resumeText",
        tooShort: "RESUME_TEXT_TOO_SHORT",
        tooLong: "RESUME_TEXT_TOO_LONG",
      },
      {
        value: sanitizedJobDescription,
        min: MIN_JOB_DESCRIPTION_LENGTH,
        max: MAX_JOB_DESCRIPTION_LENGTH,
        name: "jobDescription",
        tooShort: "JOB_DESCRIPTION_TOO_SHORT",
        tooLong: "JOB_DESCRIPTION_TOO_LONG",
      },
      {
        value: sanitizedSkills,
        min: MIN_SKILLS_LENGTH,
        max: MAX_SKILLS_LENGTH,
        name: "skills",
        tooShort: "SKILLS_TOO_SHORT",
        tooLong: "SKILLS_TOO_LONG",
      },
      {
        value: sanitizedExperience,
        min: MIN_EXPERIENCE_LENGTH,
        max: MAX_EXPERIENCE_LENGTH,
        name: "experience",
        tooShort: "EXPERIENCE_TOO_SHORT",
        tooLong: "EXPERIENCE_TOO_LONG",
      },
      {
        value: sanitizedEducation,
        min: MIN_EDUCATION_LENGTH,
        max: MAX_EDUCATION_LENGTH,
        name: "education",
        tooShort: "EDUCATION_TOO_SHORT",
        tooLong: "EDUCATION_TOO_LONG",
      },
    ];

    for (const check of fieldChecks) {
      if (check.value.length < check.min) {
        return res
          .status(400)
          .json(
            respond({
              success: false,
              message: `${check.name} is too short — please provide at least ${check.min} characters.`,
              plan: req.usage?.plan ?? null,
              usageRemaining: req.usage?.remaining ?? null,
              errors: [check.tooShort],
            }),
          );
      }
      if (check.value.length > check.max) {
        return res
          .status(400)
          .json(
            respond({
              success: false,
              message: `${check.name} is too long — please keep it under ${check.max} characters.`,
              plan: req.usage?.plan ?? null,
              usageRemaining: req.usage?.remaining ?? null,
              errors: [check.tooLong],
            }),
          );
      }
    }

    const inputForPrompt = {
      resumeText: sanitizedResumeText,
      jobDescription: sanitizedJobDescription,
      skills: sanitizedSkills,
      experience: sanitizedExperience,
      education: sanitizedEducation,
    };

    // 1. ALWAYS compute the real, deterministic score first — the AI never
    //    decides this, and it is returned even if step 2 below fails.
    const matchResult = calculateMatchScore(inputForPrompt);

    // 2. Optionally enhance with AI — a polished write-up around the score only.
    const aiResult = await tryRunSharedAIFeature({ user: req.user, input: inputForPrompt, matchResult, usage: req.usage });

    let insightsText;
    let provider;
    let fallback;

    if (aiResult) {
      fallback = false;
      provider = "ai";
      insightsText = aiResult.data.result;
    } else {
      fallback = true;
      provider = "demo-fallback";
      insightsText = buildFallbackExplanation(matchResult);
    }

    const payload = respond({
      success: true,
      message: fallback
        ? "Match score calculated. The AI provider is currently unavailable, so the write-up was generated using RemoteAI's built-in rule-based fallback instead."
        : "Match score calculated successfully.",
      plan: req.usage?.plan ?? null,
      usageRemaining: req.usage?.remaining ?? null,
      data: {
        feature: FEATURE,
        provider,
        fallback,
        score: matchResult.score,
        matchedSkills: matchResult.matchedSkills,
        missingSkills: matchResult.missingSkills,
        strengths: matchResult.strengths,
        improvements: matchResult.improvements,
        breakdown: matchResult.breakdown,
        analysis: matchResult.analysis,
        missingSkillsImpact: matchResult.missingSkillsImpact,
        improvementPlan: matchResult.improvementPlan,
        badges: matchResult.badges,
        interviewReadiness: matchResult.interviewReadiness,
        resumeRecommendations: matchResult.resumeRecommendations,
        fitSummary: matchResult.fitSummary,
        insights: insightsText,
        input: inputForPrompt,
      },
    });

    // 3. Save every successful calculation to AIHistory (best-effort, never blocks the response).
    const promptTextForHistory =
      `Resume text: ${sanitizedResumeText}\n\n` +
      `Job description: ${sanitizedJobDescription}\n\n` +
      `Skills: ${sanitizedSkills}\n\n` +
      `Experience: ${sanitizedExperience}\n\n` +
      `Education: ${sanitizedEducation}`;

    const resultTextForHistory = `Score: ${matchResult.score}/100\n\n${insightsText}`;

    await saveHistoryBestEffort({
      user: req.user,
      promptText: promptTextForHistory,
      resultText: resultTextForHistory,
      provider,
      fallback,
      metadata: { score: matchResult.score, breakdown: matchResult.breakdown },
    });

    res.status(200).json(payload);
    return next();
  } catch (err) {
    return res
      .status(500)
      .json(
        respond({
          success: false,
          message: "Something went wrong while calculating this job match score.",
          errors: [err?.message || "JOB_MATCH_SCORE_INTERNAL_ERROR"],
        }),
      );
  }
}
