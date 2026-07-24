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
  "You are the Cover Letter feature of the RemoteAI platform, a premium AI " +
  "writing assistant. You are given the applicant's name, resume text, the " +
  "target company name, job title, and job description. Write one complete, " +
  "recruiter-ready cover letter that reads like it was written by the " +
  "applicant themselves, not by a template.\n\n" +
  "GROUNDING (most important rule): every claim must trace back to the " +
  "resume text. Never invent employers, titles, dates, tools, metrics, or " +
  "accomplishments the applicant did not mention. If the resume is thin on " +
  "detail, write a shorter, honest letter rather than padding it with " +
  "invented specifics.\n\n" +
  "PERSONALIZATION: read the job description closely and identify (a) the " +
  "2-4 skills, tools, or accomplishments from the resume that most directly " +
  "match what this specific job is asking for, and (b) something concrete " +
  "and specific about the role, team, or company mission mentioned in the " +
  "job description or company name — reference that specific detail rather " +
  "than a generic compliment. Lead with the strongest, most relevant match, " +
  "not just the first thing on the resume.\n\n" +
  "ADAPT TONE TO JOB TYPE: infer the type of role and company from the job " +
  "title, description, and tone of the posting, and shift your voice " +
  "accordingly — e.g. leaner, energetic, ownership-focused language for an " +
  "early-stage startup; measured, outcomes-and-scale language for a large " +
  "enterprise; a note about independent work and clear async communication " +
  "for a remote-first role; precise, systems-and-craft language for a " +
  "technical/engineering role; audience-and-story language for a " +
  "marketing/brand role. Default to a clear, confident professional tone if " +
  "the job type isn't obvious.\n\n" +
  "STRUCTURE (four to five short paragraphs, in order): " +
  "(1) an opening that names the role and company and immediately signals " +
  "genuine, specific interest — not \"I am writing to express my interest " +
  "in...\"; " +
  "(2) a paragraph grounding the applicant's most relevant experience, " +
  "project, or achievement from the resume in what this job needs; " +
  "(3) a paragraph naming the specific skills that match the job description " +
  "and explaining, in the applicant's own logic, why that makes them a " +
  "strong fit; " +
  "(4) a short paragraph on genuine, company-specific motivation (skip this " +
  "if the job description gives nothing concrete to reference); " +
  "(5) a confident closing with a clear call to action, followed by " +
  "\"Sincerely,\" and the applicant's name on its own line.\n\n" +
  "WRITING QUALITY: vary sentence openings and structure; do not start " +
  "consecutive sentences or paragraphs the same way. Avoid AI-sounding " +
  "clichés and stock phrases entirely — do not use phrases like \"I am " +
  "writing to express my interest\", \"I believe my skills and experience " +
  "make me a strong fit\", \"I am confident that I would be a valuable " +
  "asset\", \"passionate about\", \"proven track record\", \"fast-paced " +
  "environment\" (unless the job description itself uses that exact " +
  "phrase), \"in today's competitive job market\", \"I look forward to the " +
  "possibility of contributing to your team\", or any close variant of " +
  "these. Write like a sharp, specific human, not a form letter.\n\n" +
  "FORMATTING: plain text only — no markdown, no bullet points, no " +
  "headers, no asterisks or bold markers. Separate each paragraph with a " +
  "single blank line. Keep the whole letter to roughly 250-400 words unless " +
  "the resume material genuinely supports more.";

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

  const jobType = detectJobType(`${jobTitle} ${jobDescription}`);
  const pick = makeDeterministicPicker(`${applicantName}|${jobTitle}|${companyName}`);

  const introduction = buildFallbackIntroduction({ applicantName, jobTitle, companyName, jobType, pick });
  const skillsSection = buildFallbackSkillsSection({ highlightSkills, matchedSkills, jobTitle, jobType, pick });
  const motivation = buildFallbackMotivation({ companyName, jobType, pick });
  const closing = buildFallbackClosing({ applicantName, companyName, jobType, pick });

  return { introduction, skillsSection, motivation, closing, matchedSkills };
}

/**
 * Small, dependency-free deterministic hash-based picker: the same seed
 * always returns the same index into a given options array, so identical
 * requests produce identical letters (stable for caching/re-generation)
 * while different applicants/jobs don't all read like the same boilerplate.
 * Mirrors the same approach used in src/ai/coverLetterGenerator.js.
 *
 * @param {string} seed
 * @returns {(options: string[]) => string}
 */
function makeDeterministicPicker(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (options) => options[hash % options.length];
}

/**
 * Infers a rough job-type category from the job title + description so the
 * fallback letter's tone and word choice can shift accordingly. Mirrors the
 * detector in src/ai/coverLetterGenerator.js (kept local/duplicated here
 * rather than imported, since that module's helper isn't exported and this
 * endpoint works off raw strings rather than structured Resume/Job data).
 *
 * @param {string} jobText
 * @returns {"startup"|"enterprise"|"remote"|"technical"|"marketing"|"general"}
 */
function detectJobType(jobText) {
  const text = (jobText || "").toLowerCase();
  if (!text) return "general";

  const KEYWORD_GROUPS = {
    startup: ["startup", "seed stage", "series a", "series b", "early-stage", "early stage", "fast-paced", "small team", "founding"],
    enterprise: ["enterprise", "fortune 500", "global organization", "large-scale", "cross-functional", "corporation", "multinational"],
    remote: ["remote-first", "remote first", "fully remote", "work from anywhere", "distributed team", "async"],
    marketing: ["marketing", "brand", "campaign", "seo", "content strategy", "growth marketing", "social media", "copywriting"],
    technical: ["engineer", "engineering", "developer", "backend", "frontend", "full-stack", "software", "infrastructure", "api", "architecture"],
  };

  for (const type of ["startup", "enterprise", "remote", "marketing", "technical"]) {
    if (KEYWORD_GROUPS[type].some((kw) => text.includes(kw))) return type;
  }
  return "general";
}

function buildFallbackIntroduction({ applicantName, jobTitle, companyName, jobType, pick }) {
  const openers = {
    startup: [
      `My name is ${applicantName}. The ${jobTitle} role at ${companyName} caught my attention right away — I like working somewhere I can move fast and own real outcomes.`,
      `I'm ${applicantName}, and I'm applying for the ${jobTitle} role at ${companyName}. I want to help build something early, and this looks like the right team to do it with.`,
    ],
    enterprise: [
      `My name is ${applicantName}, and I'm applying for the ${jobTitle} position at ${companyName}. I'm drawn to the scale of impact a role like this can have across a large organization.`,
      `I'm ${applicantName}. I'm writing to apply for the ${jobTitle} role at ${companyName}, having built my career delivering results in structured, cross-functional environments.`,
    ],
    remote: [
      `My name is ${applicantName}, and I'm applying for the ${jobTitle} role at ${companyName}. I've built my career working independently and communicating clearly across distributed teams.`,
      `I'm ${applicantName}. The remote-first nature of the ${jobTitle} role at ${companyName} is exactly the kind of setup where I do my best work.`,
    ],
    marketing: [
      `My name is ${applicantName}, and I'm applying for the ${jobTitle} role at ${companyName}. Telling a clear, compelling story is what I do best, and I'd like to do it for your audience.`,
      `I'm ${applicantName}. The ${jobTitle} opening at ${companyName} caught my attention immediately — I enjoy shaping the narrative behind a brand people remember.`,
    ],
    technical: [
      `My name is ${applicantName}, and I'm applying for the ${jobTitle} role at ${companyName}. Solving hard technical problems is what drew me to this posting.`,
      `I'm ${applicantName}. I'm writing to apply for the ${jobTitle} role at ${companyName} — building reliable, well-engineered systems is where I want to keep spending my time.`,
    ],
    general: [
      `My name is ${applicantName}, and I'm writing to apply for the ${jobTitle} position at ${companyName}. Reading through the role, my background lines up closely with what you're looking for.`,
      `I'm ${applicantName}. I'm excited to submit my application for the ${jobTitle} role at ${companyName} — it's a strong match for both my experience and what I want to do next.`,
    ],
  };

  const opening = pick(openers[jobType] || openers.general);
  return `Dear Hiring Manager,\n\n${opening}`;
}

function buildFallbackSkillsSection({ highlightSkills, matchedSkills, jobTitle, jobType, pick }) {
  const skillsClause =
    highlightSkills.length > 0
      ? matchedSkills.length > 0
        ? `what stood out to me in this posting is how closely it lines up with my hands-on work in ${formatList(highlightSkills)}`
        : `my core strengths are in ${formatList(highlightSkills)}`
      : `I've built a well-rounded set of skills that translates directly into the ${jobTitle} role`;

  const templates = {
    startup: [`${capitalize(skillsClause)}. I'm ready to put that directly to work in the ${jobTitle} role from day one.`],
    enterprise: [`${capitalize(skillsClause)}. I bring that same rigor and consistency to the ${jobTitle} role.`],
    remote: [`${capitalize(skillsClause)}. I'm looking forward to applying that experience to the ${jobTitle} role in a remote setting.`],
    marketing: [`${capitalize(skillsClause)}. I'd bring that same eye for what resonates to the ${jobTitle} role.`],
    technical: [`${capitalize(skillsClause)}. I'm eager to apply that depth to the ${jobTitle} role.`],
    general: [`${capitalize(skillsClause)}. I'm confident I can apply that experience effectively in the ${jobTitle} role.`],
  };

  return pick(templates[jobType] || templates.general);
}

function buildFallbackMotivation({ companyName, jobType, pick }) {
  const templates = {
    startup: [
      `What draws me to ${companyName} is the size of the problem you're taking on and the room to actually shape how it gets solved.`,
      `${companyName} stands out to me for the pace and ownership on offer — I want a role where my decisions visibly move the product forward.`,
    ],
    enterprise: [
      `${companyName}'s scale and reputation are a big part of the appeal — I want my work to hold up under real scrutiny and reach an established user base.`,
      `What appeals to me about ${companyName} is the chance to contribute to an organization with established processes and a track record I can learn from.`,
    ],
    remote: [
      `${companyName}'s remote-first approach fits how I work best — heads-down, self-directed, and communicating deliberately.`,
      `I'm drawn to ${companyName} because remote-first is clearly built into how the team operates, and that matches how I do my best work.`,
    ],
    marketing: [
      `${companyName}'s brand voice and positioning are genuinely something I admire, and I'd welcome the chance to help sharpen that story further.`,
      `What draws me to ${companyName} is the audience you've built — I'd like to help keep that relationship growing with work that actually lands.`,
    ],
    technical: [
      `${companyName}'s engineering challenges are exactly the kind of problems I find energizing to work on.`,
      `What appeals to me about ${companyName} is the technical bar you clearly hold your team to — that's the environment I want to be pushed by.`,
    ],
    general: [
      `What draws me to ${companyName} specifically is the opportunity to contribute to a team and mission I respect.`,
      `${companyName} stood out to me while researching this role, and I'd welcome the chance to contribute to what your team is building.`,
    ],
  };

  return pick(templates[jobType] || templates.general);
}

function buildFallbackClosing({ applicantName, companyName, jobType, pick }) {
  const templates = {
    startup: [`I'd welcome a conversation about where I could make the fastest impact at ${companyName}. Thanks for taking the time to review my application.`],
    enterprise: [`I'd appreciate the opportunity to discuss how my background fits your team's needs at ${companyName}. Thank you for your time and consideration.`],
    remote: [`I'd be glad to talk through how I could contribute to your distributed team at ${companyName}. Thank you for considering my application.`],
    marketing: [`I'd love the chance to talk through some early ideas for your next campaign at ${companyName}. Thanks for reviewing my application.`],
    technical: [`I'd welcome the opportunity to dig into the technical details of the role at ${companyName}. Thank you for considering my application.`],
    general: [`I'd welcome the opportunity to discuss how my background aligns with your needs at ${companyName}. Thank you for considering my application.`],
  };

  const chosen = pick(templates[jobType] || templates.general);
  return `${chosen}\n\nSincerely,\n${applicantName}`;
}

function formatList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function capitalize(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
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
