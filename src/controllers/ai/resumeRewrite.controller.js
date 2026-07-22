/**
 * src/controllers/ai/resumeRewrite.controller.js
 * ---------------------------------------------------------------------------
 * Resume Rewrite (text-only, JSON) controller.
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
 * so the shared AI architecture is used consistently across features:
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
 * rule-based rewrite that needs no external provider (see
 * `buildFallbackRewrite` below), clearly flagged as a fallback in the
 * response payload — the same "never crash, degrade gracefully" contract
 * the Resume Analyzer follows.
 *
 * This module only implements the Resume Rewrite feature. It does not
 * touch Career Coach, Cover Letter, Match Score, Mock Interview, the
 * file-upload-based /api/resume-analyzer routes, or the Resume Analyzer
 * itself, and it does not add any new models.
 */

/** Feature key used consistently across usage limits, history, and responses. */
const FEATURE = "resumeRewrite";

const MIN_RESUME_LENGTH = 50;
const MAX_RESUME_LENGTH = 12000;
const MIN_ROLE_LENGTH = 2;
const MAX_ROLE_LENGTH = 150;

// Small amount of headroom added on top of MAX_RESUME_LENGTH so the target
// role text (embedded alongside the resume in the prompt sent to the
// shared aiService) doesn't itself push a borderline-length resume over
// the limit.
const PROMPT_LENGTH_HEADROOM = 250;

const SYSTEM_INSTRUCTIONS =
  "You are the Resume Rewrite feature of the RemoteAI platform. Given the " +
  "candidate's raw resume text and a target job role, rewrite the resume " +
  "so it is clearly tailored to that role: strengthen impact statements, " +
  "surface relevant skills and keywords, tighten wording, and improve " +
  "structure and ATS-friendliness. Preserve the candidate's actual " +
  "employers, titles, dates, and experience exactly as given — never " +
  "invent or embellish qualifications, employers, or achievements the " +
  "candidate did not mention. Return the rewritten resume text.";

/**
 * Strips whitespace/control characters that have no legitimate place in
 * submitted resume text. Mirrors lib/ai/validators/sanitizeInput.js's
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
 * for the short, single-line targetRole field.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeRole(value) {
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
 * callers treat a null return as "fall back to the local rewrite".
 */
async function tryRunSharedAIFeature({ user, resumeText, targetRole, usage }) {
  try {
    const aiServiceModule = await import("../../../lib/ai/services/aiService.js");
    const runAIFeature = aiServiceModule.runAIFeature || aiServiceModule.default?.runAIFeature;

    if (typeof runAIFeature !== "function") return null;

    // Target role is embedded alongside the resume text in the single
    // prompt string aiService expects — the provider needs both pieces of
    // context to tailor the rewrite.
    const combinedPrompt = `Target role: ${targetRole}\n\n${resumeText}`;

    const result = await runAIFeature({
      feature: FEATURE,
      user,
      prompt: combinedPrompt,
      options: {
        supportedFeatures: [FEATURE],
        maxLength: MAX_RESUME_LENGTH + PROMPT_LENGTH_HEADROOM,
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
async function saveHistoryBestEffort({ user, resumeText, targetRole, resultText, provider, fallback }) {
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
      metadata: { fallback, targetRole },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[resumeRewrite] Failed to save AI history:", err?.message || err);
  }
}

/**
 * Deterministic, rule-based rewrite used only when the shared AI provider
 * is unavailable. Mirrors the spirit of src/ai/atsAnalyzer.js /
 * resumeGenerator.js: it never fabricates employers, titles, dates, or
 * achievements the candidate didn't provide — it only reformats what's
 * already there and adds a role-tailored framing line, so the response is
 * always safe to show even without a real AI call.
 *
 * @param {string} resumeText
 * @param {string} targetRole
 * @returns {string}
 */
function buildFallbackRewrite(resumeText, targetRole) {
  const lines = resumeText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bulletLine = /^([-*•▪‣]|\d+[.)])\s*/;

  const reformatted = lines.map((line) => {
    if (bulletLine.test(line)) {
      return `• ${line.replace(bulletLine, "").trim()}`;
    }
    // Lines that look like short headers (no terminal punctuation, short)
    // are left as-is; everything else becomes a bullet, matching typical
    // resume-rewrite formatting.
    if (line.length <= 60 && !/[.,;:]$/.test(line)) {
      return line;
    }
    return `• ${line}`;
  });

  const header = `Rewritten and tailored for the "${targetRole}" role.`;
  const note =
    "This version keeps every employer, title, date, and detail exactly as provided — " +
    "only wording, structure, and emphasis were adjusted for this target role.";

  return [header, "", note, "", ...reformatted].join("\n");
}

/**
 * POST /rewrite
 * Requires auth + usage-limit check (wired in resumeRewrite.routes.js).
 * Body: { resumeText: string, targetRole: string }
 *
 * On success, calls next() so the incrementUsage middleware (mounted after
 * this controller in the route) records the usage; validation failures do
 * not consume usage.
 */
export async function rewriteResume(req, res, next) {
  try {
    const resumeText = req.body && typeof req.body.resumeText === "string" ? req.body.resumeText : null;
    const targetRole = req.body && typeof req.body.targetRole === "string" ? req.body.targetRole : null;

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

    const sanitizedResume = sanitizeText(resumeText);
    const sanitizedRole = sanitizeRole(targetRole);

    if (sanitizedResume.length < MIN_RESUME_LENGTH) {
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

    if (sanitizedResume.length > MAX_RESUME_LENGTH) {
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

    if (sanitizedRole.length < MIN_ROLE_LENGTH) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: `targetRole is too short — please provide at least ${MIN_ROLE_LENGTH} characters.`,
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["TARGET_ROLE_TOO_SHORT"],
          }),
        );
    }

    if (sanitizedRole.length > MAX_ROLE_LENGTH) {
      return res
        .status(400)
        .json(
          respond({
            success: false,
            message: `targetRole is too long — please keep it under ${MAX_ROLE_LENGTH} characters.`,
            plan: req.usage?.plan ?? null,
            usageRemaining: req.usage?.remaining ?? null,
            errors: ["TARGET_ROLE_TOO_LONG"],
          }),
        );
    }

    // 1. Try the shared AI architecture first (lib/ai/services/aiService.js).
    const aiResult = await tryRunSharedAIFeature({
      user: req.user,
      resumeText: sanitizedResume,
      targetRole: sanitizedRole,
      usage: req.usage,
    });

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
        data: { ...aiResult.data, provider: "ai", fallback: false, targetRole: sanitizedRole },
      };
    } else {
      // 2. Active provider unavailable — degrade gracefully instead of
      //    crashing, using a deterministic, rule-based rewrite.
      fallback = true;
      historyProvider = "demo-fallback";
      historyResultText = buildFallbackRewrite(sanitizedResume, sanitizedRole);
      payload = respond({
        success: true,
        message:
          "The AI provider is currently unavailable, so this rewrite was generated using RemoteAI's built-in fallback rewriter instead.",
        plan: req.usage?.plan ?? null,
        usageRemaining: req.usage?.remaining ?? null,
        data: {
          feature: FEATURE,
          provider: "demo-fallback",
          fallback: true,
          targetRole: sanitizedRole,
          result: historyResultText,
        },
      });
    }

    // 3. Save every successful rewrite to AIHistory (best-effort, never blocks the response).
    await saveHistoryBestEffort({
      user: req.user,
      resumeText: sanitizedResume,
      targetRole: sanitizedRole,
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
          message: "Something went wrong while rewriting this resume.",
          errors: [err?.message || "RESUME_REWRITE_INTERNAL_ERROR"],
        }),
      );
  }
}
