/**
 * src/controllers/ai/mockInterview.controller.js
 * ---------------------------------------------------------------------------
 * Mock Interview (text-only, JSON) controller.
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
 * src/controllers/ai/jobMatchScore.controller.js so the shared AI
 * architecture is used consistently across features:
 *
 * lib/ai is loaded with a *dynamic* import wrapped in try/catch rather than
 * a static top-of-file import. That's deliberate — a static import could
 * throw at module-load time and take the whole app down with it. A dynamic
 * import lets a failure there be caught per request and turned into the
 * graceful fallback described below, instead of crashing.
 *
 * Two-mode, single-endpoint design (backward compatible):
 *   - "Start" mode (default): the request contains no `previousAnswers` —
 *     exactly the original API contract. Returns a role/experience-specific,
 *     balanced set of technical, behavioral, situational, and project-based
 *     questions with model answers, evaluation criteria, follow-ups, and
 *     prep advice.
 *   - "Evaluate" mode (additive/optional): the request additionally
 *     includes `previousAnswers` — an array of { question?, answer } the
 *     candidate has given (to questions from a prior "start" call). When
 *     present, the response also scores each answer, explains why it's
 *     strong/weak, gives a tip per answer, and closes with an overall
 *     performance summary (confidence score, hiring recommendation,
 *     personalized improvement plan) plus resume/answer-grounded follow-up
 *     questions. `previousAnswers` is optional — omitting it reproduces the
 *     original "start" behavior, so every existing caller keeps working
 *     unchanged.
 *
 * Scoring/evaluation quality: exactly like jobMatchScore.controller.js,
 * every score, badge, and recommendation here is produced by a
 * deterministic, rule-based engine (`planInterview` / `evaluateAnswers` /
 * `buildPerformanceSummary` below) — never by the AI provider. The shared
 * AI architecture is only ever used, optionally, to turn that already-final
 * analysis into a polished, "premium AI interviewer" narrative. If that
 * call fails or the provider is unavailable, this controller falls back to
 * a rule-based narrative built from the exact same analysis data, so
 * quality doesn't visibly drop and the request never fails just because the
 * AI provider is unreachable.
 *
 * The fallback (and the deterministic engine used by both modes) reuses the
 * existing src/ai/interviewQuestions.js's `generateInterviewQuestions`
 * (which itself reuses `detectSkillsInText` from src/ai/skillKeywords.js,
 * the same skill-detection module the Resume Analyzer / Cover Letter /
 * Job Match Score fallbacks use) so question selection is grounded in the
 * job title, skills, and resume text actually supplied, not fabricated.
 * That shared module is intentionally left untouched — all Mock-Interview-
 * specific additions (situational/project-based questions, answer scoring,
 * performance summary) live locally in this file.
 *
 * This module only implements the Mock Interview feature. It does not touch
 * Job Match Score, Resume Analyzer, Resume Rewrite, Career Coach, Cover
 * Letter AI, or any other route, and it does not add any new models.
 */

import { generateInterviewQuestions } from "../../ai/interviewQuestions.js";
import { detectSkillsInText } from "../../ai/skillKeywords.js";

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "mockInterview";

const MIN_JOB_TITLE_LENGTH = 2;
const MAX_JOB_TITLE_LENGTH = 150;

const MIN_EXPERIENCE_LEVEL_LENGTH = 2;
const MAX_EXPERIENCE_LEVEL_LENGTH = 100;

const MIN_SKILLS_LENGTH = 2;
const MAX_SKILLS_LENGTH = 1000;

const MIN_RESUME_TEXT_LENGTH = 50;
const MAX_RESUME_TEXT_LENGTH = 12000;

// `previousAnswers` is optional — additive to the original contract. Kept
// generous but bounded so a single request can't blow up the prompt size.
const MAX_PREVIOUS_ANSWERS = 10;
const MAX_ANSWER_LENGTH = 3000;
const MAX_ANSWER_QUESTION_LENGTH = 500;

/** Interview types this endpoint supports — validated against, case-insensitively. */
const INTERVIEW_TYPES = Object.freeze({
  TECHNICAL: "technical",
  HR: "hr",
  BEHAVIORAL: "behavioral",
});
const SUPPORTED_INTERVIEW_TYPES = Object.values(INTERVIEW_TYPES);

// Headroom added on top of the sum of the individual field maximums so the
// combined prompt (all fields plus labels/newlines/structured analysis
// block, built below) doesn't itself trip the aiService maxLength check for
// borderline inputs. Bumped up to cover the richer interview-plan/
// evaluation context now included, plus optional previousAnswers.
const PROMPT_LENGTH_HEADROOM = 4000;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_JOB_TITLE_LENGTH +
  MAX_EXPERIENCE_LEVEL_LENGTH +
  20 + // interviewType is one of three short fixed words
  MAX_SKILLS_LENGTH +
  MAX_RESUME_TEXT_LENGTH +
  (MAX_ANSWER_LENGTH + MAX_ANSWER_QUESTION_LENGTH) * MAX_PREVIOUS_ANSWERS +
  PROMPT_LENGTH_HEADROOM;

const BASE_SYSTEM_INSTRUCTIONS =
  "You are the Mock Interview feature of the RemoteAI platform, playing the role of a senior, " +
  "warm-but-rigorous human interviewer conducting a real interview — not a static question-list " +
  "generator. A backend algorithm has ALREADY built the interview plan and (when answers were " +
  "submitted) already scored every answer — you are NOT recalculating any score, badge, " +
  "recommendation, or confidence number, and you must never contradict a number given to you. " +
  "Your job is to narrate that data the way a great interviewer would talk to a candidate: " +
  "specific, encouraging where earned, direct where it isn't, and always grounded in the " +
  "candidate's actual resume/skills/answers — never invent experience, employers, projects, or " +
  "qualifications the candidate did not mention. Never write generic filler like 'good job' or " +
  "'you have relevant experience' without tying it to a specific detail you were given. " +
  "Use Markdown with clear '##' headings and numbered/bulleted sub-sections — never a wall of prose.";

const START_MODE_INSTRUCTIONS =
  BASE_SYSTEM_INSTRUCTIONS +
  " This is the START of the interview (no answers submitted yet). Structure your response with " +
  "EXACTLY these headings, in order: '## Interview Overview' (one tight paragraph on what this " +
  "session will cover and why, referencing the actual job title/experience level/interview type), " +
  "'## Interview Questions' (present the given questions as a numbered list, each tagged with its " +
  "type badge — 🧠 Technical, 🗣️ Behavioral, 🎯 Situational, or 🛠️ Project-Based — exactly as " +
  "categorized for you), '## Ideal Sample Answers' (for each question, the given model answer plus " +
  "1-2 sentences explaining SPECIFICALLY why it works), '## What Interviewers Are Listening For' " +
  "(turn the given evaluation criteria into a short per-question or per-type bullet list), " +
  "'## Likely Follow-Up Questions' (present the given follow-ups and briefly say what each is " +
  "designed to probe), and '## How To Prepare' (turn the given prep advice into a numbered action " +
  "list). Close with one short line inviting the candidate to answer and resubmit for scored " +
  "feedback. Do not invent a score or evaluation in this mode — none has been given to you yet.";

const EVALUATE_MODE_INSTRUCTIONS =
  BASE_SYSTEM_INSTRUCTIONS +
  " The candidate has SUBMITTED ANSWERS. Structure your response with EXACTLY these headings, in " +
  "order: '## Interview Overview' (one tight paragraph acknowledging what was just evaluated), " +
  "'## Answer-By-Answer Evaluation' (for EACH answer given to you, in order, use a sub-heading " +
  "with the question, then report the exact score/badge you were given, then 'Strengths' bullets, " +
  "'Weaknesses' bullets, a one-sentence specific explanation of WHY the answer scored that way, " +
  "and one 💡 Tip line — all grounded in the specific strengths/weaknesses/tip already computed for " +
  "you, never generic), '## Overall Performance Summary' (state the given confidence score and " +
  "hiring recommendation exactly, and explain the reasoning in 2-3 sentences referencing the " +
  "specific weakest and strongest categories provided), '## Personalized Improvement Plan' (turn " +
  "the given improvement plan into a prioritized numbered list, highest-impact first), and " +
  "'## Follow-Up Questions To Practice Next' (present the given follow-ups and say what gap each " +
  "one targets). Never invent a different score, badge, or recommendation than the ones given to " +
  "you.";

/**
 * Strips whitespace/control characters that have no legitimate place in
 * submitted free-text fields. Mirrors lib/ai/validators/sanitizeInput.js's
 * `sanitize()` pipeline so behavior is consistent even on the path where
 * the shared validator module isn't reachable.
 *
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
 * Same sanitization pipeline collapsed onto a single line — appropriate
 * for short, single-line fields like jobTitle/experienceLevel/interviewType.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeSingleLine(value) {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

/**
 * skills may arrive as a comma/newline separated string or as an array of
 * individual skill strings — normalize either shape into a single
 * sanitized, comma-separated string (same normalization careerCoach's
 * currentSkills field uses, for consistency across the shared AI features).
 *
 * @param {*} value
 * @returns {string|null} null if the shape is invalid
 */
function normalizeSkillsInput(value) {
  if (typeof value === "string") {
    return sanitizeSingleLine(value.replace(/\n/g, ", "));
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((item) => typeof item === "string")
      .map((item) => sanitizeSingleLine(item))
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) return null;
    return cleaned.join(", ");
  }
  return null;
}

/**
 * Validates and normalizes the optional `previousAnswers` field.
 * Accepts an array of `{ question?: string, answer: string }` objects (or
 * plain strings, treated as answer-only). Returns `{ value, error }` where
 * `value` is `[]` when the field was simply omitted (valid, default), and
 * `error` is an error code string when the field was present but malformed.
 *
 * @param {*} value
 * @returns {{ value: {question: string, answer: string}[], error: string|null }}
 */
function normalizePreviousAnswers(value) {
  if (value === undefined || value === null) {
    return { value: [], error: null };
  }
  if (!Array.isArray(value)) {
    return { value: [], error: "PREVIOUS_ANSWERS_INVALID" };
  }
  if (value.length > MAX_PREVIOUS_ANSWERS) {
    return { value: [], error: "PREVIOUS_ANSWERS_TOO_MANY" };
  }

  const normalized = [];
  for (const item of value) {
    let question = "";
    let answer = "";
    if (typeof item === "string") {
      answer = item;
    } else if (item && typeof item === "object") {
      question = typeof item.question === "string" ? item.question : "";
      answer = typeof item.answer === "string" ? item.answer : "";
    } else {
      return { value: [], error: "PREVIOUS_ANSWERS_INVALID" };
    }

    const sanitizedAnswer = sanitizeText(answer).slice(0, MAX_ANSWER_LENGTH);
    const sanitizedQuestion = sanitizeSingleLine(question).slice(0, MAX_ANSWER_QUESTION_LENGTH);

    if (sanitizedAnswer.length === 0) {
      return { value: [], error: "PREVIOUS_ANSWERS_INVALID" };
    }

    normalized.push({ question: sanitizedQuestion, answer: sanitizedAnswer });
  }

  return { value: normalized, error: null };
}

/**
 * Standard API response envelope used throughout this project (matches
 * requireAuth.js / checkUsageLimit.js / incrementUsage.js / responseBuilder.js).
 */
function respond({ success, message, plan = null, usageRemaining = null, data = null, errors = [] }) {
  return { success, message, plan, usageRemaining, data, errors };
}

/* ---------------------------------------------------------------------- */
/* Deterministic interview engine — the AI never decides plans/scores     */
/* ---------------------------------------------------------------------- */

/** Which of generateInterviewQuestions' `section`s map to each requested interviewType's primary focus. */
const SECTIONS_BY_INTERVIEW_TYPE = {
  [INTERVIEW_TYPES.TECHNICAL]: new Set(["technical", "coding"]),
  [INTERVIEW_TYPES.HR]: new Set(["hr"]),
  [INTERVIEW_TYPES.BEHAVIORAL]: new Set(["behavioral"]),
};

const TYPE_BADGES = {
  technical: "🧠 Technical",
  coding: "🧠 Technical",
  hr: "🗣️ Behavioral",
  behavioral: "🗣️ Behavioral",
  situational: "🎯 Situational",
  project: "🛠️ Project-Based",
};

const PRIMARY_QUESTION_COUNT = 4;
const SECONDARY_QUESTION_COUNT_PER_TYPE = 1;

const PROJECT_MARKERS = ["project", "built", "shipped", "launched", "developed a", "designed and built", "architected"];

/** Splits free text into rough sentences/lines for lightweight local-context extraction (mirrors the same helper in jobMatchScore.controller.js). */
function splitIntoSegments(text) {
  return (text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Generic, always-applicable situational ("what would you do if...") question templates, parameterized by job title. */
function buildSituationalQuestions(jobTitle) {
  return [
    {
      question: `Imagine you're mid-project as a ${jobTitle} and the requirements suddenly change with a hard deadline unchanged. What do you do?`,
      suggestedAnswer:
        "Reassess scope with stakeholders immediately, identify what's truly must-have vs. nice-to-have, communicate trade-offs transparently, and re-plan rather than silently absorbing the change.",
      difficulty: "intermediate",
    },
    {
      question: "You disagree with a technical or process decision your manager has made. How do you handle it?",
      suggestedAnswer:
        "Raise the concern privately with specific reasoning and, ideally, an alternative — then commit fully to the final decision once made, rather than relitigating it publicly.",
      difficulty: "intermediate",
    },
  ].map((q) => ({ ...q, section: "situational" }));
}

/**
 * Pulls project-flavored questions out of the candidate's own resume text
 * (sentences mentioning "project", "built", "shipped", etc.) so the
 * project-based questions are grounded in what the candidate actually
 * claims to have done, not a generic template.
 */
function buildProjectQuestions(resumeText, jobTitle) {
  const segments = splitIntoSegments(resumeText).filter((seg) => {
    const lower = seg.toLowerCase();
    return PROJECT_MARKERS.some((marker) => lower.includes(marker));
  });

  if (segments.length === 0) {
    return [
      {
        question: `Walk me through the most technically or operationally complex thing you've built or delivered relevant to this ${jobTitle} role.`,
        suggestedAnswer:
          "Frame it as: the problem/context, the approach and key decisions (including trade-offs considered), your specific contribution, and the measurable outcome.",
        difficulty: "intermediate",
        section: "project",
      },
    ];
  }

  return segments.slice(0, 2).map((segment) => ({
    question: `You mentioned: "${segment.length > 140 ? `${segment.slice(0, 140)}…` : segment}" — walk me through that project in detail: your role, the key decisions, and the outcome.`,
    suggestedAnswer:
      "Be specific about what YOU decided/built (not just the team), one real trade-off you navigated, and a measurable or observable result.",
    difficulty: "intermediate",
    section: "project",
  }));
}

/**
 * Builds a balanced interview plan: a primary block matching the requested
 * `interviewType` (unchanged contract — technical/hr/behavioral), plus a
 * smaller, deliberate mix of situational and project-based questions so the
 * session feels like a real, well-rounded interview rather than a single
 * category quiz. Every question is tagged with a display `typeBadge` and a
 * short `evaluationFocus` explaining what a strong answer demonstrates.
 *
 * @returns {{question: string, suggestedAnswer: string, difficulty: string, section: string, typeBadge: string, evaluationFocus: string}[]}
 */
function planInterviewQuestions({ jobTitle, experienceLevel, interviewType, skills, resumeText }) {
  const skillsList = skills
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const allBankQuestions = generateInterviewQuestions({
    title: jobTitle,
    description: `${resumeText}\n${skillsList.join(" ")}`,
    tags: skillsList,
  });

  const primarySections = SECTIONS_BY_INTERVIEW_TYPE[interviewType] || SECTIONS_BY_INTERVIEW_TYPE[INTERVIEW_TYPES.HR];
  const primaryPool = allBankQuestions.filter((q) => primarySections.has(q.section));
  const primary = (primaryPool.length > 0 ? primaryPool : allBankQuestions).slice(0, PRIMARY_QUESTION_COUNT);

  const situational = buildSituationalQuestions(jobTitle).slice(0, SECONDARY_QUESTION_COUNT_PER_TYPE);
  const project = buildProjectQuestions(resumeText, jobTitle).slice(0, SECONDARY_QUESTION_COUNT_PER_TYPE);

  // A behavioral question is added as a secondary category too, unless the
  // interview itself is already primarily behavioral (avoid duplicates).
  const behavioralSecondary =
    interviewType === INTERVIEW_TYPES.BEHAVIORAL
      ? []
      : allBankQuestions.filter((q) => q.section === "behavioral").slice(0, SECONDARY_QUESTION_COUNT_PER_TYPE);

  const combined = [...primary, ...behavioralSecondary, ...situational, ...project];

  const evaluationFocusBySection = {
    technical: `Technical accuracy, structured reasoning, and depth appropriate to a "${experienceLevel}" candidate.`,
    coding: `Correctness, clarity of approach, and awareness of time/space trade-offs appropriate to a "${experienceLevel}" candidate.`,
    hr: `Honesty, self-awareness, and genuine alignment with the "${jobTitle}" role.`,
    behavioral: "Use of a clear structure (Situation, Task, Action, Result) and a specific, real example.",
    situational: "Sound judgment under ambiguity/pressure, and a realistic, professional course of action.",
    project: "Specificity about YOUR contribution, real trade-offs faced, and a measurable or observable outcome.",
  };

  return combined.map((q, index) => ({
    id: index + 1,
    section: q.section,
    typeBadge: TYPE_BADGES[q.section] || "🗣️ Behavioral",
    difficulty: q.difficulty,
    question: q.question,
    modelAnswer: q.suggestedAnswer,
    evaluationFocus: evaluationFocusBySection[q.section] || evaluationFocusBySection.hr,
  }));
}

const STAR_MARKERS = ["situation", "task", "action", "result", "so i", "as a result", "outcome", "i decided", "i led", "i owned"];
const FILLER_PHRASES = ["um", "uh", "like,", "you know", "kind of", "sort of", "basically", "just stuff", "things like that", "i guess"];
const QUANTIFIED_RESULT_PATTERN = /\b\d+(\.\d+)?\s*(%|percent|x|hours?|days?|weeks?|months?|users?|customers?|requests?|ms|seconds?|\$)/i;

/** Extracts significant lowercase keywords (4+ chars) from free text — mirrors jobMatchScore.controller.js's approach for consistent, explainable overlap scoring. */
function extractKeywords(text) {
  const words = (text || "").toLowerCase().match(/[a-z][a-z0-9+.#-]{3,}/g) || [];
  return new Set(words);
}

/** Overlap ratio (0-1) between two keyword sets. */
function overlapRatio(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const w of setA) if (setB.has(w)) hits += 1;
  return hits / setA.size;
}

/** Status badge for a 0-100 score, consistent with jobMatchScore.controller.js's convention. */
function badgeFor(score) {
  if (score >= 80) return "🟢";
  if (score >= 50) return "🟡";
  return "🔴";
}

/**
 * Deterministically scores one candidate answer against its question
 * context. Blends: relevance (keyword overlap with the question + the
 * candidate's own listed skills/job title), structure/specificity (STAR
 * language for behavioral/situational, or technology-specific terms +
 * quantified results for technical/project answers), and clarity (a
 * reasonable length, low filler-word density). Every score is explainable
 * — the same strengths/weaknesses/tip text is used whether this is later
 * narrated by the AI or the rule-based fallback.
 */
function evaluateSingleAnswer({ answerEntry, question, skills, jobTitle }) {
  const answerText = answerEntry.answer;
  const lower = answerText.toLowerCase();
  const wordCount = (answerText.match(/\S+/g) || []).length;

  const answerKeywords = extractKeywords(answerText);
  const contextKeywords = extractKeywords(`${question?.question || answerEntry.question || ""} ${skills} ${jobTitle}`);
  const relevanceRatio = overlapRatio(contextKeywords, answerKeywords);

  const starHits = STAR_MARKERS.filter((m) => lower.includes(m)).length;
  const hasQuantifiedResult = QUANTIFIED_RESULT_PATTERN.test(answerText);
  const techTermsUsed = detectSkillsInText(answerText).length;
  const fillerHits = FILLER_PHRASES.filter((f) => lower.includes(f)).length;

  const section = question?.section || "hr";
  const isNarrativeType = section === "behavioral" || section === "situational" || section === "project";

  const structureSignal = isNarrativeType
    ? Math.min(1, starHits / 3) * 0.7 + (hasQuantifiedResult ? 0.3 : 0)
    : Math.min(1, techTermsUsed / 2) * 0.6 + (hasQuantifiedResult ? 0.4 : 0);

  const lengthSignal = wordCount < 15 ? 0.2 : wordCount < 40 ? 0.6 : wordCount <= 220 ? 1 : 0.75;
  const fillerPenalty = Math.min(0.3, fillerHits * 0.1);
  const claritySignal = Math.max(0, lengthSignal - fillerPenalty);

  const relevanceSignal = Math.min(1, relevanceRatio * 2); // small overlaps still count meaningfully

  const rawScore = relevanceSignal * 0.4 + structureSignal * 0.35 + claritySignal * 0.25;
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 100)));

  const strengths = [];
  const weaknesses = [];

  if (relevanceSignal >= 0.5) {
    strengths.push("Directly addresses the question with relevant, on-topic content rather than a generic answer.");
  } else {
    weaknesses.push("Doesn't clearly tie back to the specific question asked — the answer reads as generic or tangential.");
  }

  if (isNarrativeType) {
    if (starHits >= 2) {
      strengths.push("Uses a clear narrative structure (situation/action/result), which is exactly what interviewers listen for in behavioral/situational answers.");
    } else {
      weaknesses.push("Lacks a clear Situation → Task → Action → Result structure — the answer is harder to follow and less convincing as a real example.");
    }
  } else {
    if (techTermsUsed >= 1) {
      strengths.push("Demonstrates specific technical vocabulary/knowledge rather than staying at a surface level.");
    } else {
      weaknesses.push("Stays too high-level — naming the specific tools, concepts, or techniques used would make this far more credible.");
    }
  }

  if (hasQuantifiedResult) {
    strengths.push("Backs the answer with a measurable/quantified result, which is highly persuasive to interviewers.");
  } else {
    weaknesses.push("No measurable result or number given — quantifying the impact (%, time saved, scale, etc.) would strengthen this significantly.");
  }

  if (wordCount < 15) {
    weaknesses.push("The answer is too short to demonstrate real depth — interviewers typically want at least a few sentences of substance.");
  } else if (wordCount > 220) {
    weaknesses.push("The answer runs long — tightening it to the most relevant details keeps an interviewer's attention.");
  }

  if (fillerHits >= 2) {
    weaknesses.push("Frequent filler language (e.g. 'kind of', 'basically') dilutes the answer's confidence and clarity.");
  }

  if (strengths.length === 0) {
    strengths.push("Attempts the question directly rather than avoiding it.");
  }
  if (weaknesses.length === 0) {
    weaknesses.push("No major weaknesses detected — focus on maintaining this level of specificity across all answers.");
  }

  const tip =
    score >= 80
      ? "Keep this exact structure and specificity — it's interview-ready as-is."
      : isNarrativeType && starHits < 2
        ? "Rebuild this answer explicitly around Situation → Task → Action → Result so the structure is unmistakable to an interviewer."
        : !hasQuantifiedResult
          ? "Add one concrete number (% improvement, time saved, scale, etc.) — quantified impact is the single fastest way to raise this answer's score."
          : "Tighten the answer around the single most relevant detail for this specific question, and cut any filler language.";

  return {
    questionId: question?.id ?? null,
    question: question?.question || answerEntry.question || "(question not matched)",
    answer: answerText,
    score,
    badge: badgeFor(score),
    strengths,
    weaknesses,
    explanation:
      score >= 80
        ? `Scored high because it's relevant, specific, and ${hasQuantifiedResult ? "backed by a measurable result" : "well structured"}.`
        : score >= 50
          ? "Scored in the mid range — it's on-topic but missing either structure, specificity, or a measurable result."
          : "Scored low because it lacks relevance, structure, and/or specificity an interviewer would need to evaluate it confidently.",
    tip,
  };
}

/**
 * Matches each submitted previous answer to a question in the plan (by
 * given question text, case-insensitively; falls back to positional
 * matching), then scores every answer deterministically.
 */
function evaluateAnswers({ previousAnswers, questions, skills, jobTitle }) {
  return previousAnswers.map((entry, index) => {
    const matched =
      questions.find((q) => entry.question && q.question.toLowerCase() === entry.question.toLowerCase()) ||
      questions[index] ||
      null;
    return evaluateSingleAnswer({ answerEntry: entry, question: matched, skills, jobTitle });
  });
}

const HIRING_RECOMMENDATIONS = [
  { min: 85, label: "Strong Hire", summary: "Consistently strong, specific, well-structured answers across the board." },
  { min: 70, label: "Hire", summary: "Solid answers overall with only minor gaps to tighten up." },
  { min: 50, label: "Lean Hire — More Practice Needed", summary: "On the right track, but recurring gaps would likely raise concerns for an interview panel." },
  { min: 0, label: "Not Yet Ready", summary: "Several core answers need real rework before this would be competitive in a live interview." },
];

/**
 * Aggregates per-answer evaluations into an overall confidence score,
 * hiring-recommendation band, and a personalized improvement plan built
 * from whichever weakness categories recurred most often across all
 * answers (so the plan reflects real patterns, not a generic checklist).
 */
function buildPerformanceSummary(evaluations) {
  if (evaluations.length === 0) {
    return null;
  }

  const confidenceScore = Math.round(evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length);
  const recommendation = HIRING_RECOMMENDATIONS.find((r) => confidenceScore >= r.min);

  const weaknessThemes = new Map();
  for (const evalItem of evaluations) {
    for (const weakness of evalItem.weaknesses) {
      const key = weakness.slice(0, 60);
      weaknessThemes.set(key, (weaknessThemes.get(key) || 0) + 1);
    }
  }

  const improvementPlan = Array.from(weaknessThemes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count], index) => ({
      priority: index + 1,
      recurredIn: count,
      suggestion: theme.endsWith(".") || theme.endsWith("…") ? theme : `${theme}…`,
    }));

  const strongestAnswer = evaluations.reduce((best, e) => (e.score > best.score ? e : best), evaluations[0]);
  const weakestAnswer = evaluations.reduce((worst, e) => (e.score < worst.score ? e : worst), evaluations[0]);

  return {
    confidenceScore,
    badge: badgeFor(confidenceScore),
    hiringRecommendation: recommendation.label,
    recommendationSummary: recommendation.summary,
    strongestAnswer: { question: strongestAnswer.question, score: strongestAnswer.score },
    weakestAnswer: { question: weakestAnswer.question, score: weakestAnswer.score },
    improvementPlan,
  };
}

/** Resume/answer-grounded follow-up questions — probes the actual weak spots detected, instead of generic prompts. */
function buildFollowUpQuestions({ evaluations, skillsList, jobTitle }) {
  if (evaluations.length > 0) {
    const weakest = [...evaluations].sort((a, b) => a.score - b.score).slice(0, 2);
    const followUps = weakest.map((e) =>
      e.weaknesses.some((w) => w.includes("measurable") || w.includes("quantif"))
        ? `Going back to "${e.question}" — can you add a specific number or measurable outcome to that answer?`
        : `Going back to "${e.question}" — can you walk through that using a clearer Situation → Action → Result structure?`,
    );
    followUps.push(
      skillsList.length > 0
        ? `How have you applied ${skillsList[0]} specifically in a project you haven't already described?`
        : "Can you give one more specific, real example rather than a general approach?",
    );
    return followUps;
  }

  return [
    "Can you walk me through that in more detail, step by step?",
    "What would you have done differently with more time or resources?",
    "How did you measure whether that approach actually worked?",
    skillsList.length > 0
      ? `How have you applied ${skillsList[0]} specifically in a real project?`
      : `What does a typical week look like for you in a ${jobTitle}-type role?`,
  ];
}

/* ---------------------------------------------------------------------- */
/* Optional AI enhancement layer (premium interviewer narrative only)     */
/* ---------------------------------------------------------------------- */

/** Renders the deterministic interview plan (and, if present, evaluations/summary) into a compact prompt block so the AI narrates the same data the JSON response contains. */
function buildInterviewContextBlock({ questions, evaluations, summary, followUpQuestions, prepAdvice }) {
  const questionsBlock = questions
    .map(
      (q) =>
        `${q.id}. [${q.typeBadge}] ${q.question}\n   Model answer: ${q.modelAnswer}\n   What a strong answer shows: ${q.evaluationFocus}`,
    )
    .join("\n\n");

  let block = `Interview Plan (already finalized, do not change the questions or model answers):\n${questionsBlock}\n\n`;
  block += `Follow-Up Questions (already determined): ${followUpQuestions.join(" | ")}\n\n`;

  if (prepAdvice) {
    block += `Preparation Advice (already determined): ${prepAdvice.join(" | ")}\n\n`;
  }

  if (evaluations && evaluations.length > 0) {
    const evalBlock = evaluations
      .map(
        (e) =>
          `Q: ${e.question}\nA: ${e.answer}\nScore (already final, do not change): ${e.score}/100 ${e.badge}\nStrengths: ${e.strengths.join("; ")}\nWeaknesses: ${e.weaknesses.join("; ")}\nWhy: ${e.explanation}\nTip: ${e.tip}`,
      )
      .join("\n\n");
    block += `Answer Evaluations (already finalized, do not change any score):\n${evalBlock}\n\n`;
  }

  if (summary) {
    block +=
      `Overall Performance Summary (already finalized, do not change): Confidence score ${summary.confidenceScore}/100 ${summary.badge}, ` +
      `Hiring recommendation: "${summary.hiringRecommendation}" — ${summary.recommendationSummary}\n` +
      `Improvement Plan (already prioritized): ${summary.improvementPlan.map((p) => `${p.priority}. ${p.suggestion}`).join(" ")}`;
  }

  return block;
}

/**
 * Best-effort call into the shared aiService, used ONLY to turn the
 * already-final deterministic interview plan/evaluation into a polished,
 * premium-interviewer style Markdown narrative. Returns null (never
 * throws) if the shared AI architecture can't be loaded or fails for any
 * reason — callers treat a null return as "fall back to the local
 * narrative". No score or question is ever decided by this call.
 */
async function tryRunSharedAIFeature({
  user,
  jobTitle,
  experienceLevel,
  interviewType,
  skills,
  resumeText,
  usage,
  isEvaluateMode,
  contextBlock,
}) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    const combinedPrompt =
      `Job title: ${jobTitle}\n\n` +
      `Experience level: ${experienceLevel}\n\n` +
      `Interview type: ${interviewType}\n\n` +
      `Skills: ${skills}\n\n` +
      `Resume text: ${resumeText}\n\n` +
      `${contextBlock}`;

    const result = await runAIFeature({
      feature: FEATURE,
      user,
      prompt: combinedPrompt,
      options: {
        supportedFeatures: [FEATURE],
        maxLength: MAX_COMBINED_PROMPT_LENGTH,
        systemInstructions: isEvaluateMode ? EVALUATE_MODE_INSTRUCTIONS : START_MODE_INSTRUCTIONS,
        // History is saved once, uniformly, by this controller below —
        // regardless of whether the shared-AI or local-fallback path was
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
    console.error("[mockInterview] Failed to save AI history:", err?.message || err);
  }
}

const PREP_ADVICE_TEMPLATE = ({ jobTitle, interviewType }) => [
  `Review the ${jobTitle} job description closely and map your resume's strongest points to its requirements.`,
  `For a "${interviewType}" interview, prioritize practicing the question types above over memorizing scripted answers.`,
  "Prepare 2-3 thoughtful questions of your own to ask the interviewer at the end.",
  "Do a final review of your resume so you can speak fluently to anything on it.",
];

/**
 * Deterministic, rule-based, premium-formatted Markdown narrative used only
 * when the shared AI provider is unavailable. Built entirely from the same
 * `questions` / `evaluations` / `summary` objects the AI path would have
 * narrated — no external call, never fails — mirroring the section
 * structure the AI is instructed to produce so quality doesn't visibly drop
 * when the fallback kicks in.
 */
function buildFallbackNarrative({ questions, evaluations, summary, followUpQuestions, prepAdvice, jobTitle, experienceLevel, interviewType }) {
  if (evaluations.length === 0) {
    const overview =
      `## Interview Overview\n` +
      `This session covers a **${interviewType}**-focused mock interview for a **${jobTitle}** role at the ` +
      `**${experienceLevel}** level, blended with situational and project-based questions for a realistic, ` +
      `well-rounded session.`;

    const questionsSection =
      `## Interview Questions\n` +
      questions.map((q) => `${q.id}. **[${q.typeBadge}]** ${q.question}`).join("\n");

    const modelAnswers =
      `## Ideal Sample Answers\n` +
      questions
        .map((q) => `**${q.id}. ${q.question}**\n- Model answer: ${q.modelAnswer}\n- Why it works: ${q.evaluationFocus}`)
        .join("\n\n");

    const listening =
      `## What Interviewers Are Listening For\n` +
      questions.map((q) => `- **[${q.typeBadge}]** ${q.evaluationFocus}`).join("\n");

    const followUps = `## Likely Follow-Up Questions\n` + followUpQuestions.map((f) => `- ${f}`).join("\n");

    const prep = `## How To Prepare\n` + prepAdvice.map((p, i) => `${i + 1}. ${p}`).join("\n");

    const closing =
      `## Ready When You Are\n` +
      `Answer any of the questions above and resubmit this same request with a \`previousAnswers\` field ` +
      `(\`[{ "question": "...", "answer": "..." }]\`) to get a full scored evaluation.`;

    return [overview, questionsSection, modelAnswers, listening, followUps, prep, closing].join("\n\n");
  }

  const overview =
    `## Interview Overview\n` +
    `Evaluated **${evaluations.length}** answer${evaluations.length === 1 ? "" : "s"} for this **${interviewType}** ` +
    `**${jobTitle}** mock interview at the **${experienceLevel}** level.`;

  const evaluationSection =
    `## Answer-By-Answer Evaluation\n` +
    evaluations
      .map(
        (e, i) =>
          `### ${i + 1}. ${e.question}\n` +
          `**Score: ${e.score}/100 ${e.badge}**\n\n` +
          `**Strengths:**\n${e.strengths.map((s) => `- ${s}`).join("\n")}\n\n` +
          `**Weaknesses:**\n${e.weaknesses.map((w) => `- ${w}`).join("\n")}\n\n` +
          `**Why this score:** ${e.explanation}\n\n` +
          `💡 **Tip:** ${e.tip}`,
      )
      .join("\n\n");

  const summarySection =
    `## Overall Performance Summary\n` +
    `**Confidence Score: ${summary.confidenceScore}/100 ${summary.badge}**\n` +
    `**Hiring Recommendation: ${summary.hiringRecommendation}**\n\n` +
    `${summary.recommendationSummary} Your strongest answer was *"${summary.strongestAnswer.question}"* ` +
    `(${summary.strongestAnswer.score}/100); your weakest was *"${summary.weakestAnswer.question}"* ` +
    `(${summary.weakestAnswer.score}/100).`;

  const improvementSection =
    `## Personalized Improvement Plan\n` +
    summary.improvementPlan
      .map((p) => `${p.priority}. ${p.suggestion}${p.recurredIn > 1 ? ` (came up in ${p.recurredIn} answers)` : ""}`)
      .join("\n");

  const followUps = `## Follow-Up Questions To Practice Next\n` + followUpQuestions.map((f) => `- ${f}`).join("\n");

  return [overview, evaluationSection, summarySection, improvementSection, followUps].join("\n\n");
}

/**
 * POST /start
 * Requires auth + usage-limit check (wired in mockInterview.routes.js).
 * Body: { jobTitle, experienceLevel, interviewType, skills, resumeText,
 *         previousAnswers? }
 * `previousAnswers` is optional and additive — omit it for the original
 * "start the interview" behavior; include it to get a scored evaluation of
 * those answers plus an overall performance summary.
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function startMockInterview(req, res, next) {
  try {
    const body = req.body || {};

    const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : null;
    const experienceLevel = typeof body.experienceLevel === "string" ? body.experienceLevel : null;
    const interviewTypeRaw = typeof body.interviewType === "string" ? body.interviewType : null;
    const resumeText = typeof body.resumeText === "string" ? body.resumeText : null;
    const normalizedSkills = normalizeSkillsInput(body.skills);
    const { value: previousAnswers, error: previousAnswersError } = normalizePreviousAnswers(body.previousAnswers);

    if (jobTitle === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "jobTitle is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["JOB_TITLE_REQUIRED"],
          }),
        );
    }

    if (experienceLevel === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "experienceLevel is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["EXPERIENCE_LEVEL_REQUIRED"],
          }),
        );
    }

    if (interviewTypeRaw === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "interviewType is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["INTERVIEW_TYPE_REQUIRED"],
          }),
        );
    }

    const sanitizedInterviewType = sanitizeSingleLine(interviewTypeRaw).toLowerCase();
    if (!SUPPORTED_INTERVIEW_TYPES.includes(sanitizedInterviewType)) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: `interviewType must be one of: ${SUPPORTED_INTERVIEW_TYPES.join(", ")}.`,
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["INTERVIEW_TYPE_UNSUPPORTED"],
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

    if (previousAnswersError) {
      const messages = {
        PREVIOUS_ANSWERS_INVALID:
          "previousAnswers must be an array of strings or { question?, answer } objects with a non-empty answer.",
        PREVIOUS_ANSWERS_TOO_MANY: `previousAnswers must contain at most ${MAX_PREVIOUS_ANSWERS} items.`,
      };
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: messages[previousAnswersError] || "previousAnswers is invalid.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: [previousAnswersError],
          }),
        );
    }

    const sanitizedJobTitle = sanitizeSingleLine(jobTitle);
    const sanitizedExperienceLevel = sanitizeSingleLine(experienceLevel);
    const sanitizedSkills = normalizedSkills; // already sanitized in normalizeSkillsInput
    const sanitizedResumeText = sanitizeText(resumeText);

    const fieldChecks = [
      {
        value: sanitizedJobTitle,
        min: MIN_JOB_TITLE_LENGTH,
        max: MAX_JOB_TITLE_LENGTH,
        name: "jobTitle",
        tooShort: "JOB_TITLE_TOO_SHORT",
        tooLong: "JOB_TITLE_TOO_LONG",
      },
      {
        value: sanitizedExperienceLevel,
        min: MIN_EXPERIENCE_LEVEL_LENGTH,
        max: MAX_EXPERIENCE_LEVEL_LENGTH,
        name: "experienceLevel",
        tooShort: "EXPERIENCE_LEVEL_TOO_SHORT",
        tooLong: "EXPERIENCE_LEVEL_TOO_LONG",
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
        value: sanitizedResumeText,
        min: MIN_RESUME_TEXT_LENGTH,
        max: MAX_RESUME_TEXT_LENGTH,
        name: "resumeText",
        tooShort: "RESUME_TEXT_TOO_SHORT",
        tooLong: "RESUME_TEXT_TOO_LONG",
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
      jobTitle: sanitizedJobTitle,
      experienceLevel: sanitizedExperienceLevel,
      interviewType: sanitizedInterviewType,
      skills: sanitizedSkills,
      resumeText: sanitizedResumeText,
    };

    const skillsList = sanitizedSkills
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 1. ALWAYS build the deterministic interview plan first — the AI never
    //    decides which questions/model answers/scores are used, even when
    //    it's available (see module header).
    const questions = planInterviewQuestions(inputForPrompt);
    const isEvaluateMode = previousAnswers.length > 0;
    const evaluations = isEvaluateMode
      ? evaluateAnswers({ previousAnswers, questions, skills: sanitizedSkills, jobTitle: sanitizedJobTitle })
      : [];
    const summary = isEvaluateMode ? buildPerformanceSummary(evaluations) : null;
    const followUpQuestions = buildFollowUpQuestions({ evaluations, skillsList, jobTitle: sanitizedJobTitle });
    const prepAdvice = isEvaluateMode ? null : PREP_ADVICE_TEMPLATE(inputForPrompt);

    const contextBlock = buildInterviewContextBlock({ questions, evaluations, summary, followUpQuestions, prepAdvice });

    // 2. Optionally enhance with AI — a premium, narrated write-up of the
    //    already-final plan/evaluation (never a re-scoring or new questions).
    const aiResult = await tryRunSharedAIFeature({
      user: req.user,
      ...inputForPrompt,
      usage: req.usage,
      isEvaluateMode,
      contextBlock,
    });

    const details = { questions, evaluations, summary, followUpQuestions, prepAdvice, mode: isEvaluateMode ? "evaluate" : "start" };

    let payload;
    let historyResultText;
    let historyProvider;
    let fallback;

    const promptTextForHistory =
      `Job title: ${sanitizedJobTitle}\n\n` +
      `Experience level: ${sanitizedExperienceLevel}\n\n` +
      `Interview type: ${sanitizedInterviewType}\n\n` +
      `Skills: ${sanitizedSkills}\n\n` +
      `Resume text: ${sanitizedResumeText}` +
      (isEvaluateMode ? `\n\nPrevious answers: ${previousAnswers.map((a) => a.answer).join(" | ")}` : "");

    if (aiResult) {
      fallback = false;
      historyProvider = "ai";
      historyResultText = aiResult.data.result;
      payload = {
        ...aiResult,
        data: { ...aiResult.data, provider: "ai", fallback: false, input: inputForPrompt, details },
      };
    } else {
      // 3. Active provider unavailable — degrade gracefully instead of
      //    crashing, using the same deterministic plan/evaluation narrated
      //    by a rule-based formatter instead of the AI.
      fallback = true;
      historyProvider = "demo-fallback";
      historyResultText = buildFallbackNarrative({
        questions,
        evaluations,
        summary,
        followUpQuestions,
        prepAdvice: prepAdvice || [],
        jobTitle: sanitizedJobTitle,
        experienceLevel: sanitizedExperienceLevel,
        interviewType: sanitizedInterviewType,
      });
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this mock interview was generated using RemoteAI's built-in interview engine instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          input: inputForPrompt,
          result: historyResultText,
          details,
        },
      });
    }

    // 4. Save every successful mock interview to AIHistory (best-effort, never blocks the response).
    await saveHistoryBestEffort({
      user: req.user,
      promptText: promptTextForHistory,
      resultText: historyResultText,
      provider: historyProvider,
      fallback,
      metadata: { ...inputForPrompt, mode: details.mode, confidenceScore: summary?.confidenceScore ?? null },
    });

    res.status(200).json(payload);
    return next();
  } catch (err) {
    return res
      .status(500)
      .json(
        respond({
          success: false,
          message: "Something went wrong while starting this mock interview.",
          errors: [err?.message || "MOCK_INTERVIEW_INTERNAL_ERROR"],
        }),
      );
  }
}
