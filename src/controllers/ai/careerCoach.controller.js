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
  "You are the Career Coach inside RemoteAI — a senior, highly-paid career " +
  "strategist who has personally coached hundreds of candidates into the " +
  "exact kind of role the candidate is targeting. Your job is to turn the " +
  "candidate's career goal, current skills, experience level, and target " +
  "role into a premium, deeply personalized career plan — the quality of " +
  "advice someone would otherwise pay a professional coach for, not a " +
  "generic listicle. Every recommendation must connect explicitly back to " +
  "the specific goal, skills, experience, and target role the candidate " +
  "gave you — reference them by name throughout. Never write advice so " +
  "generic it could apply to any candidate in any field; if a sentence " +
  "would still make sense with the target role swapped out, rewrite it to " +
  "be specific instead. Never invent experience, employers, credentials, " +
  "or qualifications the candidate did not mention.\n\n" +
  "Write in confident, encouraging, expert coach language — direct, warm, " +
  "and specific, never robotic or filler-heavy. Avoid repeating the same " +
  "phrase, sentence opener, or recommendation across sections.\n\n" +
  "Format the ENTIRE response in clean Markdown using this exact structure " +
  "and section order:\n\n" +
  "## Career Roadmap\n" +
  "A short (2-3 sentence) personalized framing of the path from where the " +
  "candidate is now to their target role, naming their real starting point " +
  "and destination. Then produce four milestone subsections, each with 3-5 " +
  "concrete, non-generic bullet points describing exactly what to do and " +
  "why it matters for THIS candidate:\n" +
  "### 30-Day Milestones\n" +
  "### 90-Day Milestones\n" +
  "### 6-Month Milestones\n" +
  "### 12-Month Milestones\n\n" +
  "## Skills to Improve\n" +
  "Bullet the specific gaps between the candidate's current skills and " +
  "what their target role actually demands, ranked by impact (highest-" +
  "leverage gap first). Be precise about technologies, tools, or " +
  "competencies, not vague categories.\n\n" +
  "## Recommended Technologies & Learning Resources\n" +
  "Bullet concrete technologies/frameworks to learn, plus specific " +
  "certifications and learning resources appropriate to the target role " +
  "and the candidate's level (name real, well-known certifications and " +
  "resource types — e.g. specific certification names, reputable course " +
  "platforms, official documentation — without inventing fake ones).\n\n" +
  "## Portfolio & Real-World Practice\n" +
  "Bullet 3-5 specific project or practice ideas the candidate could build " +
  "or do that would directly showcase readiness for the target role, " +
  "tailored to their stated skills and experience.\n\n" +
  "## Interview Preparation\n" +
  "Bullet concrete interview prep steps: the types of questions/rounds " +
  "typical for this target role, how to frame the candidate's specific " +
  "experience using the STAR method, and how to address any visible gaps " +
  "honestly and confidently.\n\n" +
  "## Job Search Strategy & Salary Progression\n" +
  "Bullet actionable job-search tactics (sourcing channels, networking, " +
  "positioning) specific to the target role, plus realistic guidance on " +
  "how compensation typically progresses at this level and what to do to " +
  "move up it — without inventing specific dollar figures unless they are " +
  "well-established industry knowledge, and always framed as general " +
  "guidance rather than a guarantee.\n\n" +
  "Use bullet points and bold key terms sparingly for scannability. Do not " +
  "pad with filler sentences, disclaimers, or restating the prompt back to " +
  "the candidate.";

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
 * the candidate didn't provide — it only reframes what was submitted into a
 * premium-feeling, milestone-based plan, so the response is always safe to
 * show even without a real AI call.
 *
 * Backward compatibility note: every field this function returned before
 * (`roadmap`, `skillsToImprove`, `learningRecommendations`,
 * `resumeSuggestions`, `jobSearchAdvice`, `interviewTips`) is still present
 * with the same name and still an array of strings — existing consumers of
 * `data.details` keep working unchanged. New fields (`milestones30`,
 * `milestones90`, `milestones6Month`, `milestones12Month`, `portfolioIdeas`,
 * `salaryProgression`) are additive.
 *
 * @param {{ careerGoal: string, currentSkills: string, experience: string, targetRole: string }} input
 * @returns {{
 *   roadmap: string[], milestones30: string[], milestones90: string[],
 *   milestones6Month: string[], milestones12Month: string[],
 *   skillsToImprove: string[], learningRecommendations: string[],
 *   portfolioIdeas: string[], resumeSuggestions: string[],
 *   jobSearchAdvice: string[], salaryProgression: string[], interviewTips: string[]
 * }}
 */
function buildFallbackCareerPlan({ careerGoal, currentSkills, experience, targetRole }) {
  const skillsList = currentSkills
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const topSkills = skillsList.slice(0, 3).join(", ") || "the skills you already have";
  const allSkills = skillsList.join(", ") || currentSkills;

  // High-level roadmap kept for backward compatibility, now framed as a
  // one-line-per-horizon summary that ties directly into the detailed
  // milestone lists below instead of restating generic steps.
  const roadmap = [
    `Starting point: "${experience}" experience and current strengths in ${topSkills}, working toward "${targetRole}" in service of your goal — "${careerGoal}".`,
    "0-30 days: close the highest-leverage skill gap and get your search materials ready (see 30-Day Milestones).",
    "31-90 days: ship a portfolio-worthy project and start applying/networking in parallel (see 90-Day Milestones).",
    "3-6 months: convert interviews into offers and negotiate from a position of demonstrated skill (see 6-Month Milestones).",
    "6-12 months: land the role and set up your first promotion/raise cycle (see 12-Month Milestones).",
  ];

  const milestones30 = [
    `Map every requirement listed in real "${targetRole}" job postings against ${allSkills}, and write down the top 3 gaps.`,
    `Pick the single highest-leverage gap and start closing it this week — a focused course, official docs, or a hands-on mini-project beats passive reading.`,
    `Rewrite your resume summary and top bullet points around "${targetRole}", pulling directly from your "${experience}" experience.`,
    `Publish or update your LinkedIn/portfolio headline to state "${targetRole}" as your target, so your network and recruiters can help you.`,
    "Identify 10 target companies or teams that hire for this role and start following their job pages and people.",
  ];

  const milestones90 = [
    `Complete one substantial project or work sample that puts ${topSkills} on display in a way directly relevant to "${targetRole}".`,
    "Start applying to a mix of stretch and realistic openings — aim for a steady weekly cadence rather than a single burst.",
    "Reach out to 5-10 people already working in the target role for short conversations; ask what actually got them hired.",
    `Run at least 2 mock interviews focused on "${targetRole}" — one technical/role-specific, one behavioral — and fix what breaks.`,
    "Request feedback on your resume and portfolio from someone closer to the target role and act on it.",
  ];

  const milestones6Month = [
    `Have 2-3 portfolio pieces or measurable outcomes you can speak to fluently in an interview for "${targetRole}".`,
    "Convert your strongest early applications and conversations into active interview pipelines, not just applications sent.",
    `Close your second-highest-priority skill gap so your ${allSkills} profile has no obvious weak point for this role.`,
    "Practice negotiating: research realistic compensation ranges for the role/level/location so you're ready when an offer comes.",
    "Reassess weekly what's converting (which channels, which pitch, which project) and double down on it.",
  ];

  const milestones12Month = [
    `Land and start the "${targetRole}" role, or — if the market hasn't moved yet — have a portfolio and network strong enough that offers are a matter of when, not if.`,
    "In the first 90 days on the job, over-deliver on one visible win to set up your next review cycle.",
    "Set a concrete target for your next compensation review, tied to specific outcomes you'll own between now and then.",
    `Start scoping the role after "${targetRole}" so this plan feeds directly into your next move instead of ending here.`,
  ];

  const skillsToImprove =
    skillsList.length > 0
      ? [
          `Push your strongest existing skills (${topSkills}) from "familiar" to demonstrably job-ready for "${targetRole}" — the bar is being able to build with them unsupervised.`,
          `Identify the 2-3 skills most commonly required for "${targetRole}" that aren't yet in your list (${allSkills}) and prioritize those over anything "nice to have."`,
          "Practice applying your skills to messy, realistic scenarios or sample projects — tutorial completion doesn't read as job-ready on its own.",
        ]
      : [
          `List out the skills you already have from your background ("${experience}"), then compare them against typical "${targetRole}" requirements.`,
          "Prioritize 2-3 foundational skills for the target role and focus there first rather than spreading thin across many at once.",
        ];

  const learningRecommendations = [
    `Choose one well-reviewed, in-depth course or certification track specifically aligned with "${targetRole}" rather than several shallow ones.`,
    `Where a recognized, industry-standard certification exists for "${targetRole}", treat it as a credibility shortcut — it signals competence to recruiters skimming resumes.`,
    "Go straight to official documentation and source material for your core tools, not just secondhand tutorials — it's usually faster and more current.",
    "Follow 2-3 active communities or newsletters relevant to the target role so your skills stay current instead of going stale post-course.",
    "Find a mentor or peer group already working in the target role for periodic feedback — self-assessment alone misses blind spots.",
  ];

  const portfolioIdeas = [
    `Build one project that solves a real, specific problem using ${topSkills} — recruiters weight "solves a real problem" far above "followed a tutorial."`,
    `Rebuild or extend something from your "${experience}" background using the tools "${targetRole}" actually uses day to day, so the throughline to your target role is obvious.`,
    "Write up your project process (decisions, trade-offs, what you'd do differently) — the reasoning behind the work often matters as much as the output.",
    "Contribute to an existing open-source or community project in your target domain instead of only building solo — it shows you can work in someone else's codebase/process.",
    "Turn your best project into a short case study on your portfolio site or LinkedIn, framed around the outcome, not just the tech stack.",
  ];

  const resumeSuggestions = [
    `Reframe your experience ("${experience}") using language and keywords pulled directly from real "${targetRole}" postings.`,
    "Lead every bullet point with a measurable outcome or impact, not just a listed responsibility.",
    `Move the experience and skills most relevant to "${targetRole}" (${topSkills}) to the top of the resume — recruiters skim the first third.`,
    "Cut anything that doesn't support the target role story, even if it was a meaningful part of your background — relevance beats completeness.",
  ];

  const jobSearchAdvice = [
    `Set up alerts for "${targetRole}" openings across 2-3 job boards and review them at a consistent cadence rather than reactively.`,
    "Prioritize warm paths — referrals and direct outreach to people already in similar roles — over cold applications; they convert at a much higher rate.",
    "Tailor your application materials to each role's actual language instead of sending one generic version everywhere.",
    "Track every application, contact, and follow-up in one place so nothing goes cold from lack of a nudge.",
  ];

  const salaryProgression = [
    `Research realistic compensation ranges for "${targetRole}" at your experience level and target location/market before you're in a negotiation, not during one.`,
    "Treat your first offer at this level as a floor, not a ceiling — plan the specific outcomes that would justify your next raise before you even start.",
    "Revisit your target compensation range every 6-12 months as your portfolio and track record grow, and negotiate proactively rather than waiting to be offered more.",
    "Where possible, benchmark against multiple offers or market data rather than a single data point — leverage in negotiation comes from options.",
  ];

  const interviewTips = [
    `Prepare 3-4 STAR-method stories that map your "${experience}" experience directly onto what "${targetRole}" interviews typically probe.`,
    "Research the company and role deeply enough that your questions demonstrate genuine fit, not just interest.",
    "Practice explaining any skill gaps honestly, paired with concrete evidence of what you're actively doing to close them.",
    `Rehearse a tight, confident answer to "why ${targetRole}, why now" that ties back to your stated goal — "${careerGoal}".`,
  ];

  return {
    roadmap,
    milestones30,
    milestones90,
    milestones6Month,
    milestones12Month,
    skillsToImprove,
    learningRecommendations,
    portfolioIdeas,
    resumeSuggestions,
    jobSearchAdvice,
    salaryProgression,
    interviewTips,
  };
}

/** Renders the local rule-based plan into a readable Markdown summary (used for history + as the `result` text). */
function buildFallbackSummaryText(plan) {
  const section = (title, items) => `## ${title}\n- ${items.join("\n- ")}`;

  return [
    section("Career Roadmap", plan.roadmap),
    section("30-Day Milestones", plan.milestones30),
    section("90-Day Milestones", plan.milestones90),
    section("6-Month Milestones", plan.milestones6Month),
    section("12-Month Milestones", plan.milestones12Month),
    section("Skills to Improve", plan.skillsToImprove),
    section("Recommended Technologies & Learning Resources", plan.learningRecommendations),
    section("Portfolio & Real-World Practice", plan.portfolioIdeas),
    section("Resume Improvement Suggestions", plan.resumeSuggestions),
    section("Job Search Strategy", plan.jobSearchAdvice),
    section("Salary Progression", plan.salaryProgression),
    section("Interview Preparation", plan.interviewTips),
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
