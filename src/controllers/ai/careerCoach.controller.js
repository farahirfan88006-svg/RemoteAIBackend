/**
 * src/controllers/ai/careerCoach.controller.js
 * ---------------------------------------------------------------------------
 * Career Coach (text-only, JSON) controller.
 *
 * Reuses the existing shared AI architecture under lib/ai instead of
 * building new plumbing:
 *   - lib/ai/services/aiService.js        (runAIFeature — provider-agnostic entry point)
 *   - lib/ai/providers/*                  (resolved internally by aiService)
 *   - lib/ai/services/historyService.js   (AIHistory persistence)
 *   - src/middleware/checkUsageLimit.js / incrementUsage.js (usage limits, wired in the route)
 *   - src/middleware/requireAuth.js       (auth, wired in the route)
 *
 * This module intentionally mirrors src/controllers/ai/resumeAnalyzer.controller.js
 * and src/controllers/ai/resumeRewrite.controller.js so the shared AI
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
 * rule-based career plan that needs no external provider (see
 * `buildFallbackCareerPlan` below), clearly flagged as a fallback in the
 * response payload — the same "never crash, degrade gracefully" contract
 * the Resume Analyzer / Resume Rewrite follow.
 *
 * This module only implements the Career Coach feature. It does not touch
 * Cover Letter, Match Score, Mock Interview, Resume Analyzer, Resume
 * Rewrite, or any other route, and it does not add any new models.
 */

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "careerCoach";

const MIN_GOAL_LENGTH = 3;
const MAX_GOAL_LENGTH = 500;

const MIN_SKILLS_LENGTH = 2;
const MAX_SKILLS_LENGTH = 1000;

const MIN_EXPERIENCE_LENGTH = 1;
const MAX_EXPERIENCE_LENGTH = 500;

const MIN_ROLE_LENGTH = 2;
const MAX_ROLE_LENGTH = 150;

// Headroom added on top of the sum of the individual field maximums so the
// combined prompt (all four fields plus labels/newlines, built below)
// doesn't itself trip the aiService maxLength check for borderline inputs.
const PROMPT_LENGTH_HEADROOM = 500;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_GOAL_LENGTH + MAX_SKILLS_LENGTH + MAX_EXPERIENCE_LENGTH + MAX_ROLE_LENGTH + PROMPT_LENGTH_HEADROOM;

const SYSTEM_INSTRUCTIONS =
  "You are the Career Coach feature of the RemoteAI platform. Given the " +
  "candidate's career goal, current skills, experience level, and target " +
  "role, produce a clear, encouraging, and actionable career development " +
  "plan. Structure your response with these sections: (1) Career Roadmap " +
  "— a step-by-step path from where they are now to their target role, " +
  "(2) Skills to Improve — specific gaps between their current skills and " +
  "the target role, (3) Learning Recommendations — concrete courses, " +
  "certifications, or resources, (4) Resume Improvement Suggestions, " +
  "(5) Job Search Advice, and (6) Interview Preparation Tips. Never invent " +
  "experience, employers, or qualifications the candidate did not mention.";

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
 * for short, single-line fields like targetRole/experience.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeSingleLine(value) {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

/**
 * currentSkills may arrive as a comma/newline separated string or as an
 * array of individual skill strings — normalize either shape into a single
 * sanitized, comma-separated string.
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
 * callers treat a null return as "fall back to the local career plan".
 */
async function tryRunSharedAIFeature({ user, careerGoal, currentSkills, experience, targetRole, usage }) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    // All four fields are embedded alongside labels in the single prompt
    // string aiService expects — the provider needs each piece of context
    // to build a relevant, personalized career plan.
    const combinedPrompt =
      `Career goal: ${careerGoal}\n\n` +
      `Current skills: ${currentSkills}\n\n` +
      `Experience: ${experience}\n\n` +
      `Target role: ${targetRole}`;

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
    console.error("[careerCoach] Failed to save AI history:", err?.message || err);
  }
}

/**
 * Deterministic, rule-based career plan used only when the shared AI
 * provider is unavailable. Mirrors the spirit of resumeRewrite's
 * `buildFallbackRewrite`: it never fabricates experience or qualifications
 * the candidate didn't provide — it only reframes what was submitted into
 * the six required sections, so the response is always safe to show even
 * without a real AI call.
 *
 * @param {{ careerGoal: string, currentSkills: string, experience: string, targetRole: string }} input
 * @returns {{ roadmap: string[], skillsToImprove: string[], learningRecommendations: string[], resumeSuggestions: string[], jobSearchAdvice: string[], interviewTips: string[] }}
 */
function buildFallbackCareerPlan({ careerGoal, currentSkills, experience, targetRole }) {
  const skillsList = currentSkills
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const roadmap = [
    `Clarify your target: aim for "${targetRole}" while keeping your broader goal — "${careerGoal}" — in view.`,
    `Audit your current experience ("${experience}") against the typical requirements for "${targetRole}".`,
    "Close the highest-impact skill gaps first (see Skills to Improve below).",
    "Build or update one portfolio project or work sample that demonstrates the target role's core skills.",
    `Apply to a mix of stretch and realistic "${targetRole}" openings while continuing to learn.`,
  ];

  const skillsToImprove =
    skillsList.length > 0
      ? [
          `Deepen your strongest existing skills (${skillsList.slice(0, 3).join(", ")}) to a job-ready level for "${targetRole}".`,
          `Identify 2-3 skills commonly required for "${targetRole}" that aren't yet in your list (${skillsList.join(", ")}) and prioritize those.`,
          "Practice applying your skills to realistic scenarios or sample projects, not just tutorials.",
        ]
      : [
          `List out the skills you already have, then compare them against typical "${targetRole}" requirements.`,
          "Prioritize 2-3 foundational skills for the target role and focus there first.",
        ];

  const learningRecommendations = [
    `Look for a well-reviewed course or certification specifically aligned with "${targetRole}".`,
    "Follow industry blogs, newsletters, or communities relevant to the target role to stay current.",
    "Seek a mentor or peer group already working in the target role for feedback and guidance.",
  ];

  const resumeSuggestions = [
    `Reframe your experience ("${experience}") using language and keywords common to "${targetRole}" postings.`,
    "Lead bullet points with measurable outcomes and impact rather than just responsibilities.",
    "Move the most relevant skills and experience for the target role near the top of the resume.",
  ];

  const jobSearchAdvice = [
    `Set up alerts for "${targetRole}" openings and review them weekly.`,
    "Prioritize referrals and networking — reach out to people already in similar roles.",
    "Tailor your application materials to each role instead of sending one generic version.",
  ];

  const interviewTips = [
    `Prepare 2-3 stories (using the STAR method) that map your experience to what "${targetRole}" interviews typically probe.`,
    "Research the company and role deeply so your questions and answers show genuine fit.",
    "Practice explaining any skill gaps honestly, paired with what you're actively doing to close them.",
  ];

  return { roadmap, skillsToImprove, learningRecommendations, resumeSuggestions, jobSearchAdvice, interviewTips };
}

/** Renders the local rule-based plan into a short readable summary string (used for history + as the `result` text). */
function buildFallbackSummaryText(plan) {
  const section = (title, items) => `${title}:\n- ${items.join("\n- ")}`;

  return [
    section("Career Roadmap", plan.roadmap),
    section("Skills to Improve", plan.skillsToImprove),
    section("Learning Recommendations", plan.learningRecommendations),
    section("Resume Improvement Suggestions", plan.resumeSuggestions),
    section("Job Search Advice", plan.jobSearchAdvice),
    section("Interview Preparation Tips", plan.interviewTips),
  ].join("\n\n");
}

/**
 * POST /advice
 * Requires auth + usage-limit check (wired in careerCoach.routes.js).
 * Body: { careerGoal: string, currentSkills: string|string[], experience: string, targetRole: string }
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function getCareerAdvice(req, res, next) {
  try {
    const body = req.body || {};

    const careerGoal = typeof body.careerGoal === "string" ? body.careerGoal : null;
    const experience = typeof body.experience === "string" ? body.experience : null;
    const targetRole = typeof body.targetRole === "string" ? body.targetRole : null;
    const normalizedSkills = normalizeSkillsInput(body.currentSkills);

    if (careerGoal === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "careerGoal is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["CAREER_GOAL_REQUIRED"],
          }),
        );
    }

    if (normalizedSkills === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "currentSkills is required and must be a non-empty string or array of strings.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["CURRENT_SKILLS_REQUIRED"],
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

    if (targetRole === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "targetRole is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["TARGET_ROLE_REQUIRED"],
          }),
        );
    }

    const sanitizedGoal = sanitizeSingleLine(careerGoal);
    const sanitizedSkills = normalizedSkills; // already sanitized in normalizeSkillsInput
    const sanitizedExperience = sanitizeText(experience);
    const sanitizedRole = sanitizeSingleLine(targetRole);

    const fieldChecks = [
      {
        value: sanitizedGoal,
        min: MIN_GOAL_LENGTH,
        max: MAX_GOAL_LENGTH,
        name: "careerGoal",
        tooShort: "CAREER_GOAL_TOO_SHORT",
        tooLong: "CAREER_GOAL_TOO_LONG",
      },
      {
        value: sanitizedSkills,
        min: MIN_SKILLS_LENGTH,
        max: MAX_SKILLS_LENGTH,
        name: "currentSkills",
        tooShort: "CURRENT_SKILLS_TOO_SHORT",
        tooLong: "CURRENT_SKILLS_TOO_LONG",
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
        value: sanitizedRole,
        min: MIN_ROLE_LENGTH,
        max: MAX_ROLE_LENGTH,
        name: "targetRole",
        tooShort: "TARGET_ROLE_TOO_SHORT",
        tooLong: "TARGET_ROLE_TOO_LONG",
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
      careerGoal: sanitizedGoal,
      currentSkills: sanitizedSkills,
      experience: sanitizedExperience,
      targetRole: sanitizedRole,
    };

    // 1. Try the shared AI architecture first (lib/ai/services/aiService.js).
    const aiResult = await tryRunSharedAIFeature({ user: req.user, ...inputForPrompt, usage: req.usage });

    let payload;
    let historyResultText;
    let historyProvider;
    let fallback;

    const promptTextForHistory =
      `Career goal: ${sanitizedGoal}\n\n` +
      `Current skills: ${sanitizedSkills}\n\n` +
      `Experience: ${sanitizedExperience}\n\n` +
      `Target role: ${sanitizedRole}`;

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
      //    crashing, using a deterministic, rule-based career plan.
      fallback = true;
      historyProvider = "demo-fallback";
      const plan = buildFallbackCareerPlan(inputForPrompt);
      historyResultText = buildFallbackSummaryText(plan);
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this career plan was generated using RemoteAI's built-in career coach fallback instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          input: inputForPrompt,
          result: historyResultText,
          details: plan,
        },
      });
    }

    // 3. Save every successful plan to AIHistory (best-effort, never blocks the response).
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
          message: "Something went wrong while generating career advice.",
          errors: [err?.message || "CAREER_COACH_INTERNAL_ERROR"],
        }),
      );
  }
}
