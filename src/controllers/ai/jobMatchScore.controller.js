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
 * AI architecture is only ever used, optionally, to add a plain-language
 * explanation, improvement suggestions, and career advice *on top of* the
 * already-final score — if that call fails or the provider is unavailable,
 * this controller falls back to rule-based explanations for those same
 * sections and still returns the full, real, algorithmic score. The
 * request never fails just because the AI provider is unreachable.
 *
 * This module only implements the Job Match Score feature. It does not
 * touch Resume Analyzer, Resume Rewrite, Career Coach, Cover Letter AI,
 * Mock Interview, or any other route, and it does not add any new models.
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
// combined prompt (all five fields plus labels/newlines, built below)
// doesn't itself trip the aiService maxLength check for borderline inputs.
const PROMPT_LENGTH_HEADROOM = 1000;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_RESUME_TEXT_LENGTH +
  MAX_JOB_DESCRIPTION_LENGTH +
  MAX_SKILLS_LENGTH +
  MAX_EXPERIENCE_LENGTH +
  MAX_EDUCATION_LENGTH +
  PROMPT_LENGTH_HEADROOM;

const SYSTEM_INSTRUCTIONS =
  "You are the Job Match Score feature of the RemoteAI platform. A backend " +
  "algorithm has ALREADY calculated the candidate's match score and the " +
  "matched/missing skills — you are NOT calculating or restating a " +
  "different score, and you must not contradict the score given to you. " +
  "Your only job is to add: (1) a short, plain-language Explanation of why " +
  "the score is what it is, referencing the specific matched/missing " +
  "skills provided, (2) concrete Improvement Suggestions the candidate " +
  "could act on to raise their match for this specific job, and (3) brief " +
  "Career Advice relevant to this application. Never invent experience, " +
  "employers, or qualifications the candidate did not mention.";

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

/**
 * Skills component (40% weight): matches the candidate's explicitly-listed
 * `skills` field against keywords/phrases appearing in the job description
 * (case-insensitive substring matching), blended with a general keyword
 * overlap between the resume+skills text and the job description as a
 * whole. This covers both "skills keyword matching" and "job description
 * keyword overlap" from the same underlying signal.
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
    ratio: Math.max(0, Math.min(1, ratio)),
    matched: matchedPhrases.map(toDisplayCase),
    missing: missingPhrases.map(toDisplayCase),
  };
}

/**
 * Technology component (20% weight): uses the shared `detectSkillsInText`
 * taxonomy (the same one the Resume Analyzer / Cover Letter / Mock
 * Interview fallbacks use) to find concrete technologies (languages,
 * frameworks, cloud, tools) mentioned in the job description, then checks
 * how many of those are also present in the candidate's resume+skills text.
 * Distinct from the freeform skills-field matching above — this is a
 * narrower, canonical tech-stack match.
 */
function computeTechnologyMatch({ resumeText, skills, jobDescription }) {
  const jobTech = detectSkillsInText(jobDescription);
  const candidateTech = detectSkillsInText(`${resumeText}\n${skills}`);
  const candidateSlugs = new Set(candidateTech.map((t) => t.slug));

  if (jobTech.length === 0) {
    // Job description doesn't mention any known technology by name — don't
    // penalize the candidate for something the job never asked for.
    return { ratio: 1, matched: [], missing: [] };
  }

  const matched = jobTech.filter((t) => candidateSlugs.has(t.slug));
  const missing = jobTech.filter((t) => !candidateSlugs.has(t.slug));

  return {
    ratio: matched.length / jobTech.length,
    matched: matched.map((t) => t.name),
    missing: missing.map((t) => t.name),
  };
}

const YEARS_PATTERN = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/i;

/** Extracts the first "N years"/"N+ years" figure found in free text, or null. */
function extractYears(text) {
  const match = YEARS_PATTERN.exec(text || "");
  return match ? parseFloat(match[1]) : null;
}

const SENIORITY_KEYWORDS = [
  "intern", "entry-level", "entry level", "junior", "associate", "mid-level",
  "mid level", "senior", "lead", "principal", "staff", "manager", "director",
];

/** Which of SENIORITY_KEYWORDS appear in a piece of text. */
function detectSeniorityKeywords(text) {
  const lower = (text || "").toLowerCase();
  return SENIORITY_KEYWORDS.filter((kw) => lower.includes(kw));
}

/**
 * Experience component (25% weight): prefers comparing an explicit
 * "N years" figure from the job description against one from the
 * candidate's `experience` field. Falls back to seniority-keyword overlap
 * (junior/mid/senior/lead/etc.) when the job description doesn't state a
 * specific number of years.
 */
function computeExperienceMatch({ experience, jobDescription }) {
  const requiredYears = extractYears(jobDescription);
  const candidateYears = extractYears(experience);

  if (requiredYears !== null && candidateYears !== null) {
    const ratio = requiredYears <= 0 ? 1 : Math.max(0, Math.min(1, candidateYears / requiredYears));
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
 * Education component (15% weight): compares the candidate's stated
 * education level against any education level mentioned in the job
 * description, using a simple degree-level hierarchy. If the job
 * description doesn't mention education at all, the candidate isn't
 * penalized for it.
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

const WEIGHTS = {
  skills: 0.4,
  experience: 0.25,
  technology: 0.2,
  education: 0.15,
};

/**
 * The core, deterministic Job Match Score algorithm. No AI/LLM call is
 * involved in producing `score`, `matchedSkills`, or `missingSkills` — this
 * function alone is the source of truth for those values.
 *
 * @param {{ resumeText: string, jobDescription: string, skills: string, experience: string, education: string }} input
 * @returns {{
 *   score: number,
 *   matchedSkills: string[],
 *   missingSkills: string[],
 *   strengths: string[],
 *   improvements: string[],
 *   breakdown: { skillsMatch: number, technologyMatch: number, experienceMatch: number, educationMatch: number },
 * }}
 */
function calculateMatchScore({ resumeText, jobDescription, skills, experience, education }) {
  const jobDescriptionLower = jobDescription.toLowerCase();
  const skillPhrases = tokenizePhraseList(skills);

  const skillsResult = computeSkillsMatch({ skillPhrases, jobDescriptionLower, resumeText, skills, jobDescription });
  const technologyResult = computeTechnologyMatch({ resumeText, skills, jobDescription });
  const experienceResult = computeExperienceMatch({ experience, jobDescription });
  const educationResult = computeEducationMatch({ education, jobDescription });

  const weightedScore =
    skillsResult.ratio * WEIGHTS.skills +
    experienceResult.ratio * WEIGHTS.experience +
    technologyResult.ratio * WEIGHTS.technology +
    educationResult.ratio * WEIGHTS.education;

  const score = Math.max(0, Math.min(100, Math.round(weightedScore * 100)));

  const matchedSkills = dedupeCaseInsensitive([...technologyResult.matched, ...skillsResult.matched]);
  const missingSkills = dedupeCaseInsensitive([...technologyResult.missing, ...skillsResult.missing]);

  const strengths = [];
  const improvements = [];

  if (skillsResult.matched.length > 0) {
    strengths.push(`Your listed skills overlap well with the job description (matched: ${skillsResult.matched.join(", ")}).`);
  } else if (skillPhrases.length > 0) {
    improvements.push("None of your listed skills were found in the job description — consider tailoring your skills list to the terms this job actually uses.");
  }

  if (technologyResult.matched.length > 0) {
    strengths.push(`You match key technologies this role requires: ${technologyResult.matched.join(", ")}.`);
  }
  if (technologyResult.missing.length > 0) {
    improvements.push(`This role mentions technologies not found in your resume/skills: ${technologyResult.missing.join(", ")}. Add them if you have real experience with them.`);
  }

  if (experienceResult.basis === "years") {
    if (experienceResult.candidateYears >= experienceResult.requiredYears) {
      strengths.push(`Your experience (${experienceResult.candidateYears} years) meets or exceeds the ${experienceResult.requiredYears} years this role asks for.`);
    } else {
      improvements.push(`This role asks for ${experienceResult.requiredYears} years of experience; you listed ${experienceResult.candidateYears}. Emphasize depth/impact to help close that gap.`);
    }
  } else if (experienceResult.ratio < 0.5) {
    improvements.push("Your experience level doesn't clearly match the seniority this job description implies — consider clarifying your seniority/scope of responsibility.");
  }

  if (educationResult.jobLevel > 0 && educationResult.candidateLevel < educationResult.jobLevel) {
    improvements.push("Your stated education is below the level mentioned in the job description — highlight equivalent experience or certifications if you have them.");
  } else if (educationResult.jobLevel > 0) {
    strengths.push("Your education level meets what this job description asks for.");
  }

  if (strengths.length === 0) {
    strengths.push("You meet the baseline requirements described in the job posting.");
  }
  if (improvements.length === 0) {
    improvements.push("Your profile is well aligned with this job — consider tailoring your resume's wording to mirror the job description's exact terms for ATS purposes.");
  }

  return {
    score,
    matchedSkills,
    missingSkills,
    strengths,
    improvements,
    breakdown: {
      skillsMatch: Math.round(skillsResult.ratio * 100),
      technologyMatch: Math.round(technologyResult.ratio * 100),
      experienceMatch: Math.round(experienceResult.ratio * 100),
      educationMatch: Math.round(educationResult.ratio * 100),
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Optional AI enhancement layer (explanation / suggestions / advice only) */
/* ---------------------------------------------------------------------- */

/**
 * Best-effort call into the shared aiService, used ONLY to generate a
 * plain-language explanation, improvement suggestions, and career advice
 * around the already-final algorithmic score. Returns null (never throws)
 * if the shared AI architecture can't be loaded or fails for any reason —
 * callers treat a null return as "fall back to the local explanation".
 * The score itself is passed in as context and is never altered by this.
 */
async function tryRunSharedAIFeature({ user, input, matchResult, usage }) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    const combinedPrompt =
      `Calculated match score (already final, do not change): ${matchResult.score}/100\n\n` +
      `Matched skills/technologies: ${matchResult.matchedSkills.join(", ") || "none detected"}\n\n` +
      `Missing skills/technologies: ${matchResult.missingSkills.join(", ") || "none detected"}\n\n` +
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
        // regardless of whether the AI or local-fallback explanation was
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
 * Deterministic, rule-based explanation/suggestions/advice text used only
 * when the shared AI provider is unavailable. Built entirely from the
 * already-calculated score/breakdown/strengths/improvements — no external
 * call, never fails.
 */
function buildFallbackExplanation(matchResult) {
  const { score, breakdown, strengths, improvements } = matchResult;

  const explanation =
    `Explanation:\nYour overall match score is ${score}/100, based on: skills match ${breakdown.skillsMatch}% ` +
    `(40% weight), experience match ${breakdown.experienceMatch}% (25% weight), technology match ` +
    `${breakdown.technologyMatch}% (20% weight), and education match ${breakdown.educationMatch}% (15% weight).`;

  const suggestions = `Improvement Suggestions:\n- ${improvements.join("\n- ")}`;

  const careerAdvice =
    `Career Advice:\nUse the strengths above in your application, and address the improvement points before ` +
    `applying if you can. Tailoring your resume's language to closely mirror this job description's own wording ` +
    `typically improves both ATS keyword matching and human recruiter screening.`;

  const strengthsText = `Strengths:\n- ${strengths.join("\n- ")}`;

  return [explanation, strengthsText, suggestions, careerAdvice].join("\n\n");
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

    // 2. Optionally enhance with AI — explanation/suggestions/advice only.
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
        ? "Match score calculated. The AI provider is currently unavailable, so explanations/suggestions were generated using RemoteAI's built-in rule-based fallback instead."
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
