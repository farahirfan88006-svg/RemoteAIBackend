/**
 * src/controllers/ai/resumeAnalyzer.controller.js
 * ---------------------------------------------------------------------------
 * Resume Analyzer (text-only, JSON) controller.
 *
 * Reuses the existing shared AI architecture under lib/ai instead of
 * building new plumbing:
 *   - lib/ai/services/aiService.js        (runAIFeature — provider-agnostic entry point)
 *   - lib/ai/providers/*                  (resolved internally by aiService)
 *   - lib/ai/services/historyService.js   (AIHistory persistence)
 *   - src/middleware/checkUsageLimit.js / incrementUsage.js (usage limits, wired in the route)
 *   - src/middleware/requireAuth.js       (auth, wired in the route)
 *
 * Everything under lib/ai is loaded with a *dynamic* import wrapped in
 * try/catch rather than a static top-of-file import. That's deliberate:
 * lib/ai is still being wired up (see the CANDIDATE_*_PATHS / "INTEGRATION
 * NOTE" comments in providerResolver.js and historyService.js), so a
 * static import could throw at module-load time and take the whole app
 * down with it. A dynamic import lets a failure there be caught per
 * request and turned into the graceful fallback described below, instead
 * of crashing.
 *
 * Fallback behavior:
 * If the shared AI service / active provider can't be reached for any
 * reason (not yet wired, provider stub not implemented, transient error),
 * this controller does NOT return a 5xx. It falls back to the resume
 * analysis that already exists in this codebase and needs no external
 * provider — src/ai/atsAnalyzer.js's deterministic, rule-based
 * `analyzeResumeText` — and returns that instead, clearly flagged as a
 * fallback in the response payload.
 *
 * This module only implements the Resume Analyzer. It does not touch any
 * other AI feature, the file-upload-based /api/resume-analyzer routes, or
 * anything outside src/controllers/ai and src/routes/ai.
 */

import { analyzeResumeText } from "../../ai/atsAnalyzer.js";

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "resumeAnalyzer";

const MIN_RESUME_LENGTH = 50;
const MAX_RESUME_LENGTH = 12000;

const SYSTEM_INSTRUCTIONS =
  "You are the Resume Analyzer inside RemoteAI — an expert resume coach and " +
  "former technical recruiter who has screened thousands of resumes against " +
  "real ATS pipelines. Given the candidate's raw resume text, write a " +
  "premium, specific, and encouraging analysis — the kind a paid resume " +
  "review service would deliver, not a generic checklist.\n\n" +
  "Ground every observation in the candidate's actual wording: quote or " +
  "closely paraphrase the specific line, bullet, or section you're " +
  "commenting on so the feedback is obviously tailored to this resume, not " +
  "boilerplate. Never invent experience, employers, titles, dates, or " +
  "qualifications the candidate did not mention, and never fabricate a " +
  "quote from the resume.\n\n" +
  "Structure the response in this exact order, using Markdown:\n" +
  "1. '## ATS Score' — a single score out of 100 on its own line as " +
  "'**Score: NN/100 — <one-word verdict>**', followed by one sentence on " +
  "why (e.g. missing sections, weak keyword coverage, thin metrics).\n" +
  "2. '## Executive Summary' — 2-3 sentences giving the candidate a clear, " +
  "honest read on where this resume stands and the single biggest lever to " +
  "improve it.\n" +
  "3. '## Section-by-Section Feedback' — a short subsection for each " +
  "section actually present in the resume (e.g. Summary, Experience, " +
  "Education, Skills), each with 1-2 sentences of specific, actionable " +
  "feedback tied to that section's real content. Call out any core " +
  "section (contact info, experience, education, skills) that is missing " +
  "or too thin.\n" +
  "4. '## ATS & Keyword Analysis' — note whether formatting is ATS-safe " +
  "(bullet points, no tables/columns/graphics implied by the text, clear " +
  "headings), list 3-6 relevant keywords/skills the resume already " +
  "demonstrates, and 3-6 relevant keywords or skills for this candidate's " +
  "apparent field that are notably absent and worth adding if genuinely " +
  "applicable.\n" +
  "5. '## Strengths' — 2-4 bullets on what is already working well, each " +
  "referencing specific resume content.\n" +
  "6. '## Top Recommendations' — exactly 3-5 prioritized, concrete " +
  "suggestions ordered by impact, each one bullet, each actionable enough " +
  "to apply immediately (e.g. 'Quantify the impact in your \"led a team\" " +
  "bullet — add team size and the outcome').\n\n" +
  "Tone: direct, warm, and specific — like a skilled human coach, not a " +
  "corporate template. Avoid filler phrases like 'overall this is a good " +
  "resume' without immediately following with concrete evidence. Keep the " +
  "entire response under roughly 450 words so it stays scannable.";

/**
 * Strips whitespace/control characters that have no legitimate place in
 * submitted resume text. Mirrors lib/ai/validators/sanitizeInput.js's
 * `sanitize()` pipeline so behavior is consistent even on the path where
 * the shared validator module isn't reachable.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeResumeText(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * callers treat a null return as "fall back to the local analyzer".
 */
async function tryRunSharedAIFeature({ user, resumeText, usage }) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    const result = await runAIFeature({
      feature: FEATURE,
      user,
      prompt: resumeText,
      options: {
        supportedFeatures: [FEATURE],
        maxLength: MAX_RESUME_LENGTH,
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
async function saveHistoryBestEffort({ user, resumeText, resultText, provider, fallback }) {
  try {
    const historyModule = await import("../../../lib/ai/services/historyService.js");
    const saveHistory = historyModule.saveHistory || historyModule.default?.saveHistory;
    if (typeof saveHistory !== "function") return;

    await saveHistory({
      user,
      feature: FEATURE,
      prompt: resumeText,
      response: resultText,
      provider,
      metadata: { fallback },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[resumeAnalyzer] Failed to save AI history:", err?.message || err);
  }
}

/**
 * Renders the local rule-based analysis into a polished, premium-feeling
 * Markdown report. Mirrors the structure of the AI-generated report
 * (ATS Score -> Executive Summary -> Section-by-Section -> Keywords ->
 * Strengths -> Recommendations) so the experience feels consistent
 * regardless of which path (shared AI or local fallback) served the
 * request. All data here is derived purely from `analysis` (produced by
 * src/ai/atsAnalyzer.js) — nothing is invented.
 */
function buildFallbackSummaryText(analysis) {
  const sections = [];

  const verdict = analysis.ratingLabel || (analysis.atsScore >= 70 ? "Solid" : "Needs work");
  sections.push(`## ATS Score\n**Score: ${analysis.atsScore}/100 — ${verdict}**`);

  if (analysis.summary) {
    sections.push(`## Executive Summary\n${analysis.summary}`);
  }

  if (Array.isArray(analysis.sectionFeedback) && analysis.sectionFeedback.length) {
    const rows = analysis.sectionFeedback.map(
      (s) => `- **${s.name}** ${s.present ? "✅" : "⚠️ Missing"} — ${s.note}`,
    );
    sections.push(`## Section-by-Section Feedback\n${rows.join("\n")}`);
  }

  const keywordLines = [];
  if (analysis.formattingIssues?.length) {
    keywordLines.push(`Formatting: ${analysis.formattingIssues.join(" ")}`);
  }
  if (analysis.detectedSkills?.length) {
    keywordLines.push(`Skills already reflected: ${analysis.detectedSkills.map((s) => s.name).join(", ")}.`);
  }
  if (analysis.missingKeywords?.length) {
    keywordLines.push(`In-demand skills not detected: ${analysis.missingKeywords.join(", ")} — add any that genuinely apply.`);
  }
  if (keywordLines.length) {
    sections.push(`## ATS & Keyword Analysis\n${keywordLines.join("\n")}`);
  }

  if (analysis.strengths?.length) {
    sections.push(`## Strengths\n${analysis.strengths.map((s) => `- ${s}`).join("\n")}`);
  }

  if (analysis.suggestions?.length) {
    sections.push(`## Top Recommendations\n${analysis.suggestions.map((s) => `- ${s}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * POST /analyze
 * Requires auth + usage-limit check (wired in resumeAnalyzer.routes.js).
 * Body: { resumeText: string }
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function analyzeResume(req, res, next) {
  try {
    const resumeText = req.body && typeof req.body.resumeText === "string" ? req.body.resumeText : null;

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

    const sanitized = sanitizeResumeText(resumeText);

    if (sanitized.length < MIN_RESUME_LENGTH) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: `resumeText is too short — please provide at least ${MIN_RESUME_LENGTH} characters of resume content.`,
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["RESUME_TEXT_TOO_SHORT"],
          }),
        );
    }

    if (sanitized.length > MAX_RESUME_LENGTH) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: `resumeText is too long — please keep it under ${MAX_RESUME_LENGTH} characters.`,
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["RESUME_TEXT_TOO_LONG"],
          }),
        );
    }

    // 1. Try the shared AI architecture first (lib/ai/services/aiService.js).
    const aiResult = await tryRunSharedAIFeature({ user: req.user, resumeText: sanitized, usage: req.usage });

    let payload;
    let historyResultText;
    let historyProvider;
    let fallback;

    if (aiResult) {
      fallback = false;
      historyProvider = "ai";
      historyResultText = aiResult.data.result;
      payload = {
        ...aiResult,
        data: { ...aiResult.data, provider: "ai", fallback: false },
      };
    } else {
      // 2. Active provider unavailable — degrade gracefully instead of
      //    crashing, using the existing rule-based resume analyzer.
      fallback = true;
      historyProvider = "demo-fallback";
      const analysis = await analyzeResumeText(sanitized);
      historyResultText = buildFallbackSummaryText(analysis);
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this analysis was generated using RemoteAI's built-in resume analyzer instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          result: historyResultText,
          details: analysis,
        },
      });
    }

    // 3. Save every successful analysis to AIHistory (best-effort, never blocks the response).
    await saveHistoryBestEffort({
      user: req.user,
      resumeText: sanitized,
      resultText: historyResultText,
      provider: historyProvider,
      fallback,
    });

    res.status(200).json(payload);
    return next();
  } catch (err) {
    return res
      .status(500)
      .json(
        respond({
          success: false,
          message: "Something went wrong while analyzing this resume.",
          errors: [err?.message || "RESUME_ANALYZER_INTERNAL_ERROR"],
        }),
      );
  }
}
