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
 * and src/controllers/ai/coverLetterAI.controller.js so the shared AI
 * architecture is used consistently across features:
 *
 * lib/ai is loaded with a *dynamic* import wrapped in try/catch rather than
 * a static top-of-file import. That's deliberate — a static import could
 * throw at module-load time and take the whole app down with it. A dynamic
 * import lets a failure there be caught per request and turned into the
 * graceful fallback described below, instead of crashing.
 *
 * Fallback behavior:
 * If the shared AI service / active provider can't be reached for any
 * reason (not yet wired, provider stub not implemented, transient error),
 * this controller does NOT return a 5xx. It falls back to a deterministic,
 * rule-based mock interview that needs no external provider (see
 * `buildFallbackMockInterview` below), clearly flagged as a fallback in the
 * response payload — the same "never crash, degrade gracefully" contract
 * the other AI features follow. The fallback reuses the existing
 * src/ai/interviewQuestions.js's `generateInterviewQuestions` (which itself
 * reuses `detectSkillsInText` from src/ai/skillKeywords.js, the same
 * skill-detection module the Resume Analyzer / Cover Letter fallback use)
 * so question selection is grounded in the job title, skills, and resume
 * text actually supplied, not fabricated.
 *
 * This module only implements the Mock Interview feature. It does not touch
 * Job Match Score, Resume Analyzer, Resume Rewrite, Career Coach, Cover
 * Letter AI, or any other route, and it does not add any new models.
 */

import { generateInterviewQuestions } from "../../ai/interviewQuestions.js";

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

/** Interview types this endpoint supports — validated against, case-insensitively. */
const INTERVIEW_TYPES = Object.freeze({
  TECHNICAL: "technical",
  HR: "hr",
  BEHAVIORAL: "behavioral",
});
const SUPPORTED_INTERVIEW_TYPES = Object.values(INTERVIEW_TYPES);

// Headroom added on top of the sum of the individual field maximums so the
// combined prompt (all five fields plus labels/newlines, built below)
// doesn't itself trip the aiService maxLength check for borderline inputs.
const PROMPT_LENGTH_HEADROOM = 500;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_JOB_TITLE_LENGTH +
  MAX_EXPERIENCE_LEVEL_LENGTH +
  20 + // interviewType is one of three short fixed words
  MAX_SKILLS_LENGTH +
  MAX_RESUME_TEXT_LENGTH +
  PROMPT_LENGTH_HEADROOM;

const SYSTEM_INSTRUCTIONS =
  "You are the Mock Interview feature of the RemoteAI platform. Given the " +
  "candidate's target job title, experience level, requested interview type " +
  "(technical, hr, or behavioral), skills, and resume text, run a realistic " +
  "mock interview. Structure your response with these parts, in order: " +
  "(1) Interview Questions — a set of questions appropriate to the requested " +
  "interview type, job title, and experience level, (2) Model Answers — a " +
  "strong example answer for each question, (3) Evaluation Criteria — what " +
  "an interviewer would look for in a good answer to each question, " +
  "(4) Improvement Tips — specific, actionable ways the candidate can " +
  "strengthen weak areas given their skills/experience level, (5) Follow-up " +
  "Questions — plausible probing questions an interviewer might ask after " +
  "each answer, and (6) Interview Preparation Advice — general guidance for " +
  "preparing for this specific interview. Never invent experience, " +
  "employers, or qualifications the candidate did not mention.";

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
 * Standard API response envelope used throughout this project (matches
 * requireAuth.js / checkUsageLimit.js / incrementUsage.js / responseBuilder.js).
 */
function respond({ success, message, plan = null, usageRemaining = null, data = null, errors = [] }) {
  return { success, message, plan, usageRemaining, data, errors };
}

/**
 * Best-effort call into the shared aiService. Returns null (never throws)
 * if the shared AI architecture can't be loaded or fails for any reason —
 * callers treat a null return as "fall back to the local mock interview".
 */
async function tryRunSharedAIFeature({
  user,
  jobTitle,
  experienceLevel,
  interviewType,
  skills,
  resumeText,
  usage,
}) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    // All five fields are embedded alongside labels in the single prompt
    // string aiService expects — the provider needs each piece of context
    // to run a relevant, personalized mock interview.
    const combinedPrompt =
      `Job title: ${jobTitle}\n\n` +
      `Experience level: ${experienceLevel}\n\n` +
      `Interview type: ${interviewType}\n\n` +
      `Skills: ${skills}\n\n` +
      `Resume text: ${resumeText}`;

    const result = await runAIFeature({
      feature: FEATURE,
      user,
      prompt: combinedPrompt,
      options: {
        supportedFeatures: [FEATURE],
        maxLength: MAX_COMBINED_PROMPT_LENGTH,
        systemInstructions: SYSTEM_INSTRUCTIONS,
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

/** Which question `section`s (from generateInterviewQuestions) map to each requested interviewType. */
const SECTIONS_BY_INTERVIEW_TYPE = {
  [INTERVIEW_TYPES.TECHNICAL]: new Set(["technical", "coding"]),
  [INTERVIEW_TYPES.HR]: new Set(["hr"]),
  [INTERVIEW_TYPES.BEHAVIORAL]: new Set(["behavioral"]),
};

const MAX_FALLBACK_QUESTIONS = 6;

/**
 * Deterministic, rule-based mock interview used only when the shared AI
 * provider is unavailable. Reuses the existing
 * src/ai/interviewQuestions.js's `generateInterviewQuestions` (job-shaped
 * input: title/description/tags) so question selection is grounded in the
 * job title, skills, and resume content actually supplied, filtered down to
 * the requested interview type.
 *
 * Never invents experience, employers, or qualifications the candidate
 * didn't provide — it only reframes the supplied information into the
 * required sections, so the response is always safe to show even without a
 * real AI call.
 *
 * @param {{ jobTitle: string, experienceLevel: string, interviewType: string, skills: string, resumeText: string }} input
 * @returns {{ questions: object[], evaluationCriteria: string[], improvementTips: string[], followUpQuestions: string[], prepAdvice: string[] }}
 */
function buildFallbackMockInterview({ jobTitle, experienceLevel, interviewType, skills, resumeText }) {
  const skillsList = skills
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // generateInterviewQuestions expects a job-shaped object; the resume text
  // and skills list stand in for a job description/tags so skill detection
  // (shared with the Resume Analyzer / Cover Letter fallback) has real
  // content to match against.
  const allQuestions = generateInterviewQuestions({
    title: jobTitle,
    description: `${resumeText}\n${skillsList.join(" ")}`,
    tags: skillsList,
  });

  const wantedSections = SECTIONS_BY_INTERVIEW_TYPE[interviewType] || SECTIONS_BY_INTERVIEW_TYPE[INTERVIEW_TYPES.HR];
  const filtered = allQuestions.filter((q) => wantedSections.has(q.section));
  const selected = (filtered.length > 0 ? filtered : allQuestions).slice(0, MAX_FALLBACK_QUESTIONS);

  const questions = selected.map((q, index) => ({
    id: index + 1,
    section: q.section,
    difficulty: q.difficulty,
    question: q.question,
    modelAnswer: q.suggestedAnswer,
  }));

  const evaluationCriteriaByType = {
    [INTERVIEW_TYPES.TECHNICAL]: [
      "Technical accuracy and correctness of the explanation or solution.",
      `Depth appropriate to a "${experienceLevel}" candidate — neither superficial nor beyond what the role requires.`,
      "Clear, structured communication of a technical concept or trade-off.",
      "Ability to relate the answer back to real, hands-on experience rather than pure theory.",
    ],
    [INTERVIEW_TYPES.HR]: [
      "Clarity and honesty of the answer.",
      `Alignment between stated motivations/expectations and the "${jobTitle}" role.`,
      "Professionalism and self-awareness in how the answer is framed.",
    ],
    [INTERVIEW_TYPES.BEHAVIORAL]: [
      "Use of a clear structure (e.g. Situation, Task, Action, Result) rather than a vague summary.",
      "Specificity — a real example with concrete details, not a generic statement.",
      "Evidence of reflection or learning from the experience described.",
    ],
  };

  const improvementTips = [
    skillsList.length > 0
      ? `Practice explaining ${skillsList.slice(0, 3).join(", ")} out loud, in plain language, since interviewers weigh clear communication as much as raw knowledge.`
      : "Identify the 2-3 skills most relevant to this role and prepare a concrete example for each.",
    `Prepare answers calibrated to a "${experienceLevel}" level — avoid over- or under-selling your experience relative to the role.`,
    "Record yourself answering a few questions out loud and review for filler words, pacing, and structure.",
    `Research ${jobTitle} interviews at similar companies so your preparation matches what's actually likely to be asked.`,
  ];

  const followUpQuestions = [
    "Can you walk me through that in more detail, step by step?",
    "What would you have done differently if you had more time or resources?",
    "How did you measure whether that approach actually worked?",
    skillsList.length > 0
      ? `How have you applied ${skillsList[0]} specifically in a real project?`
      : "Can you give a specific, real example rather than a general approach?",
  ];

  const prepAdvice = [
    `Review the ${jobTitle} job description closely and map your resume's strongest points to its requirements.`,
    `For a "${interviewType}" interview, prioritize practicing the question types above over memorizing scripted answers.`,
    "Prepare 2-3 thoughtful questions of your own to ask the interviewer at the end.",
    "Do a final review of your resume so you can speak fluently to anything on it.",
  ];

  return {
    questions,
    evaluationCriteria: evaluationCriteriaByType[interviewType] || evaluationCriteriaByType[INTERVIEW_TYPES.HR],
    improvementTips,
    followUpQuestions,
    prepAdvice,
  };
}

/** Renders the local rule-based mock interview into a short readable summary string (used for history + as the `result` text). */
function buildFallbackSummaryText(interview) {
  const section = (title, items) => `${title}:\n- ${items.join("\n- ")}`;

  const questionsBlock = interview.questions
    .map(
      (q, i) =>
        `${i + 1}. ${q.question}\n   Model answer: ${q.modelAnswer}\n   Evaluation focus: ${q.difficulty} difficulty, ${q.section} section`,
    )
    .join("\n\n");

  return [
    `Interview Questions & Model Answers:\n${questionsBlock}`,
    section("Evaluation Criteria", interview.evaluationCriteria),
    section("Improvement Tips", interview.improvementTips),
    section("Follow-up Questions", interview.followUpQuestions),
    section("Interview Preparation Advice", interview.prepAdvice),
  ].join("\n\n");
}

/**
 * POST /start
 * Requires auth + usage-limit check (wired in mockInterview.routes.js).
 * Body: { jobTitle, experienceLevel, interviewType, skills, resumeText }
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

    // 1. Try the shared AI architecture first (lib/ai/services/aiService.js).
    const aiResult = await tryRunSharedAIFeature({ user: req.user, ...inputForPrompt, usage: req.usage });

    let payload;
    let historyResultText;
    let historyProvider;
    let fallback;

    const promptTextForHistory =
      `Job title: ${sanitizedJobTitle}\n\n` +
      `Experience level: ${sanitizedExperienceLevel}\n\n` +
      `Interview type: ${sanitizedInterviewType}\n\n` +
      `Skills: ${sanitizedSkills}\n\n` +
      `Resume text: ${sanitizedResumeText}`;

    if (aiResult) {
      fallback = false;
      historyProvider = "ai";
      historyResultText = aiResult.data.result;
      payload = {
        ...aiResult,
        data: { ...aiResult.data, provider: "ai", fallback: false, input: inputForPrompt },
      };
    } else {
      // 2. Active provider unavailable — degrade gracefully instead of
      //    crashing, using a deterministic, rule-based mock interview.
      fallback = true;
      historyProvider = "demo-fallback";
      const interview = buildFallbackMockInterview(inputForPrompt);
      historyResultText = buildFallbackSummaryText(interview);
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this mock interview was generated using RemoteAI's built-in interview question bank instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          input: inputForPrompt,
          result: historyResultText,
          details: interview,
        },
      });
    }

    // 3. Save every successful mock interview to AIHistory (best-effort, never blocks the response).
    await saveHistoryBestEffort({
      user: req.user,
      promptText: promptTextForHistory,
      resultText: historyResultText,
      provider: historyProvider,
      fallback,
      metadata: inputForPrompt,
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
