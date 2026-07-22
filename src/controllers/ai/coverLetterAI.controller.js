/**
 * src/controllers/ai/coverLetterAI.controller.js
 * ---------------------------------------------------------------------------
 * Cover Letter (text-only, JSON) controller.
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
 * src/controllers/ai/resumeRewrite.controller.js, and
 * src/controllers/ai/careerCoach.controller.js so the shared AI architecture
 * is used consistently across features:
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
 * rule-based cover letter that needs no external provider (see
 * `buildFallbackCoverLetter` below), clearly flagged as a fallback in the
 * response payload — the same "never crash, degrade gracefully" contract
 * the Resume Analyzer / Resume Rewrite / Career Coach follow. The fallback
 * reuses the same skill-matching approach as the existing
 * src/ai/coverLetterGenerator.js (via src/ai/skillKeywords.js's
 * `detectSkillsInText`) so "tailored to the job" concretely means "leads
 * with the skills that actually overlap between the resume and the job
 * description", not just interpolating the company name into a fixed
 * template.
 *
 * This module only implements the Cover Letter feature. It does not touch
 * Career Coach, Resume Analyzer, Resume Rewrite, Mock Interview, Job Match
 * Score, or any other route, and it does not add any new models.
 */

import { detectSkillsInText } from "../../ai/skillKeywords.js";

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "coverLetter";

const MIN_COMPANY_NAME_LENGTH = 2;
const MAX_COMPANY_NAME_LENGTH = 150;

const MIN_JOB_TITLE_LENGTH = 2;
const MAX_JOB_TITLE_LENGTH = 150;

const MIN_JOB_DESCRIPTION_LENGTH = 20;
const MAX_JOB_DESCRIPTION_LENGTH = 8000;

const MIN_APPLICANT_NAME_LENGTH = 2;
const MAX_APPLICANT_NAME_LENGTH = 150;

const MIN_RESUME_TEXT_LENGTH = 50;
const MAX_RESUME_TEXT_LENGTH = 12000;

// Headroom added on top of the sum of the individual field maximums so the
// combined prompt (all five fields plus labels/newlines, built below)
// doesn't itself trip the aiService maxLength check for borderline inputs.
const PROMPT_LENGTH_HEADROOM = 500;

const MAX_COMBINED_PROMPT_LENGTH =
  MAX_COMPANY_NAME_LENGTH +
  MAX_JOB_TITLE_LENGTH +
  MAX_JOB_DESCRIPTION_LENGTH +
  MAX_APPLICANT_NAME_LENGTH +
  MAX_RESUME_TEXT_LENGTH +
  PROMPT_LENGTH_HEADROOM;

const SYSTEM_INSTRUCTIONS =
  "You are the Cover Letter feature of the RemoteAI platform. Given the " +
  "applicant's name, resume text, the target company name, job title, and " +
  "job description, write a complete, professional cover letter. Structure " +
  "your response with these parts, in order: (1) a personalized introduction " +
  "that names the applicant, the role, and the company, (2) a relevant " +
  "skills section that highlights the applicant's actual experience/skills " +
  "that match the job description, (3) a paragraph expressing genuine, " +
  "company-specific motivation for wanting to work there, and (4) a strong " +
  "closing paragraph with a call to action and a sign-off using the " +
  "applicant's name. Never invent experience, employers, or qualifications " +
  "the applicant did not mention in their resume text.";

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
 * for short, single-line fields like companyName/jobTitle/applicantName.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeSingleLine(value) {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
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
 * callers treat a null return as "fall back to the local cover letter".
 */
async function tryRunSharedAIFeature({
  user,
  companyName,
  jobTitle,
  jobDescription,
  applicantName,
  resumeText,
  usage,
}) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    // All five fields are embedded alongside labels in the single prompt
    // string aiService expects — the provider needs each piece of context
    // to write a relevant, personalized, company-specific cover letter.
    const combinedPrompt =
      `Applicant name: ${applicantName}\n\n` +
      `Company name: ${companyName}\n\n` +
      `Job title: ${jobTitle}\n\n` +
      `Job description: ${jobDescription}\n\n` +
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
    console.error("[coverLetterAI] Failed to save AI history:", err?.message || err);
  }
}

/**
 * Deterministic, rule-based cover letter used only when the shared AI
 * provider is unavailable. Reuses the same skill-overlap approach as the
 * existing src/ai/coverLetterGenerator.js (via detectSkillsInText), applied
 * directly to the raw resumeText/jobDescription strings this endpoint
 * accepts, so the "tailored" skills section is grounded in the applicant's
 * actual resume content rather than fabricated.
 *
 * Never invents experience, employers, or qualifications the applicant
 * didn't provide — it only reframes the supplied information into the
 * required sections, so the response is always safe to show even without a
 * real AI call.
 *
 * @param {{ companyName: string, jobTitle: string, jobDescription: string, applicantName: string, resumeText: string }} input
 * @returns {{ introduction: string, skillsSection: string, motivation: string, closing: string, matchedSkills: string[] }}
 */
function buildFallbackCoverLetter({ companyName, jobTitle, jobDescription, applicantName, resumeText }) {
  const resumeSkills = detectSkillsInText(resumeText).map((s) => s.name);
  const jobSkills = detectSkillsInText(jobDescription).map((s) => s.name);

  // Skills the applicant actually has AND the job actually mentions — the
  // genuinely "tailored" part, not just any of the applicant's skills.
  const matchedSkills = jobSkills.filter((skill) =>
    resumeSkills.some((owned) => owned.toLowerCase() === skill.toLowerCase()),
  );
  const highlightSkills = (matchedSkills.length > 0 ? matchedSkills : resumeSkills).slice(0, 5);

  const introduction =
    `Dear Hiring Manager,\n\n` +
    `My name is ${applicantName}, and I am writing to express my strong interest in the ` +
    `${jobTitle} position at ${companyName}. Having reviewed the role's requirements, I am ` +
    `confident that my background and experience make me a strong candidate for this opportunity.`;

  const skillsSection =
    highlightSkills.length > 0
      ? `${
          matchedSkills.length > 0
            ? "My experience aligns closely with what you are looking for, particularly in"
            : "Throughout my career, I have built strong expertise in"
        } ${highlightSkills.join(", ")}. I have applied these skills to deliver real results, and I am eager ` +
        `to bring that same impact to the ${jobTitle} role.`
      : `Throughout my career, I have developed a well-rounded skill set that I believe translates ` +
        `directly into success in the ${jobTitle} role.`;

  const motivation =
    `What draws me to ${companyName} specifically is the opportunity to contribute to a team and ` +
    `mission I genuinely respect. I am excited by the prospect of growing alongside ${companyName} and ` +
    `applying my skills toward its continued success, and I am confident my background positions me to ` +
    `make a meaningful contribution from day one.`;

  const closing =
    `I would welcome the opportunity to discuss how my background aligns with your needs at ${companyName} ` +
    `in more detail. Thank you for considering my application — I look forward to the possibility of ` +
    `contributing to your team.\n\n` +
    `Sincerely,\n${applicantName}`;

  return { introduction, skillsSection, motivation, closing, matchedSkills };
}

/** Renders the local rule-based cover letter into a single full letter string. */
function buildFallbackLetterText(letter) {
  return [letter.introduction, letter.skillsSection, letter.motivation, letter.closing].join("\n\n");
}

/**
 * POST /generate
 * Requires auth + usage-limit check (wired in coverLetterAI.routes.js).
 * Body: { companyName, jobTitle, jobDescription, applicantName, resumeText }
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function generateCoverLetterAI(req, res, next) {
  try {
    const body = req.body || {};

    const companyName = typeof body.companyName === "string" ? body.companyName : null;
    const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : null;
    const jobDescription = typeof body.jobDescription === "string" ? body.jobDescription : null;
    const applicantName = typeof body.applicantName === "string" ? body.applicantName : null;
    const resumeText = typeof body.resumeText === "string" ? body.resumeText : null;

    if (companyName === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "companyName is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["COMPANY_NAME_REQUIRED"],
          }),
        );
    }

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

    if (applicantName === null) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: "applicantName is required and must be a string.",
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["APPLICANT_NAME_REQUIRED"],
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

    const sanitizedCompanyName = sanitizeSingleLine(companyName);
    const sanitizedJobTitle = sanitizeSingleLine(jobTitle);
    const sanitizedJobDescription = sanitizeText(jobDescription);
    const sanitizedApplicantName = sanitizeSingleLine(applicantName);
    const sanitizedResumeText = sanitizeText(resumeText);

    const fieldChecks = [
      {
        value: sanitizedCompanyName,
        min: MIN_COMPANY_NAME_LENGTH,
        max: MAX_COMPANY_NAME_LENGTH,
        name: "companyName",
        tooShort: "COMPANY_NAME_TOO_SHORT",
        tooLong: "COMPANY_NAME_TOO_LONG",
      },
      {
        value: sanitizedJobTitle,
        min: MIN_JOB_TITLE_LENGTH,
        max: MAX_JOB_TITLE_LENGTH,
        name: "jobTitle",
        tooShort: "JOB_TITLE_TOO_SHORT",
        tooLong: "JOB_TITLE_TOO_LONG",
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
        value: sanitizedApplicantName,
        min: MIN_APPLICANT_NAME_LENGTH,
        max: MAX_APPLICANT_NAME_LENGTH,
        name: "applicantName",
        tooShort: "APPLICANT_NAME_TOO_SHORT",
        tooLong: "APPLICANT_NAME_TOO_LONG",
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
      companyName: sanitizedCompanyName,
      jobTitle: sanitizedJobTitle,
      jobDescription: sanitizedJobDescription,
      applicantName: sanitizedApplicantName,
      resumeText: sanitizedResumeText,
    };

    // 1. Try the shared AI architecture first (lib/ai/services/aiService.js).
    const aiResult = await tryRunSharedAIFeature({ user: req.user, ...inputForPrompt, usage: req.usage });

    let payload;
    let historyResultText;
    let historyProvider;
    let fallback;

    const promptTextForHistory =
      `Applicant name: ${sanitizedApplicantName}\n\n` +
      `Company name: ${sanitizedCompanyName}\n\n` +
      `Job title: ${sanitizedJobTitle}\n\n` +
      `Job description: ${sanitizedJobDescription}\n\n` +
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
      //    crashing, using a deterministic, rule-based cover letter.
      fallback = true;
      historyProvider = "demo-fallback";
      const letter = buildFallbackCoverLetter(inputForPrompt);
      historyResultText = buildFallbackLetterText(letter);
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this cover letter was generated using RemoteAI's built-in cover letter generator instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          input: inputForPrompt,
          result: historyResultText,
          details: letter,
        },
      });
    }

    // 3. Save every successful cover letter to AIHistory (best-effort, never blocks the response).
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
          message: "Something went wrong while generating this cover letter.",
          errors: [err?.message || "COVER_LETTER_AI_INTERNAL_ERROR"],
        }),
      );
  }
}
