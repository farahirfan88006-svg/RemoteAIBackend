/**
 * AI Resume Generator — expansion logic only.
 *
 * IMPORTANT — what "AI" means here (documented plainly, same as
 * ai/atsAnalyzer.js): this is template/rule-based text generation, not
 * an LLM call — there's no model API configured in this project. It
 * takes minimal structured input and produces resume-shaped content
 * (a written summary, normalized section data), which the user then
 * edits like any other resume.
 *
 * Deliberately produces a payload in the EXACT shape
 * resumeValidators.js/models/Resume.js already expect — this function
 * does no persistence and defines no new schema. resumes.controller.js's
 * `generateResume` handler takes this payload and calls the same
 * `Resume.create` path as the ordinary `createResume` handler, so
 * "generated" and "manually created" resumes are indistinguishable data
 * once saved — one storage/CRUD/PDF/template path for both, per "reuse
 * the existing Resume Builder, do not duplicate resume logic".
 *
 * Deliberately does NOT invent unverifiable achievement claims for a
 * role missing a description (e.g. "increased revenue by 30%") — that
 * would put fabricated claims on someone's resume as if they were fact.
 * Instead it leaves a clearly-labeled placeholder prompting the user to
 * fill in real specifics, and generates the parts that are safe to
 * derive mechanically (a summary paragraph assembled from the skills/
 * roles the user *did* provide, headline, section normalization).
 */

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function skillNames(skills = []) {
  return skills.map((s) => (typeof s === "string" ? s : s?.name)).filter(isNonEmpty);
}

/** Builds a short, honest professional summary from what was actually provided — no invented facts. */
function generateSummary({ headline, experience = [], skills = [] }) {
  const topSkills = skillNames(skills).slice(0, 5);
  const roleCount = experience.length;
  const mostRecent = experience[0];

  const parts = [];
  if (headline) {
    parts.push(`${headline} with ${roleCount > 0 ? `${roleCount} role${roleCount === 1 ? "" : "s"} of` : ""} professional experience.`.replace("with  role", "with professional"));
  } else if (mostRecent?.title) {
    parts.push(`${mostRecent.title} with professional experience across ${roleCount} role${roleCount === 1 ? "" : "s"}.`);
  } else {
    parts.push("Motivated professional building a career across the roles and skills below.");
  }

  if (mostRecent?.company) {
    parts.push(`Most recently at ${mostRecent.company}${mostRecent.title ? ` as ${mostRecent.title}` : ""}.`);
  }
  if (topSkills.length > 0) {
    parts.push(`Core skills include ${topSkills.join(", ")}.`);
  }

  return parts.join(" ");
}

function normalizeExperience(experience = []) {
  return experience.map((entry) => ({
    company: entry.company || "",
    title: entry.title || "",
    location: entry.location || "",
    startDate: entry.startDate || "",
    endDate: entry.endDate || "",
    current: Boolean(entry.current),
    // Never fabricates specifics — see file-level comment. Only fills in
    // a neutral prompt when the user left this blank, so the resume
    // never silently ships an empty, oddly-blank-looking entry either.
    description: isNonEmpty(entry.description)
      ? entry.description
      : "Add 1-3 bullet points describing your responsibilities and impact in this role.",
  }));
}

function normalizeSkills(skills = []) {
  return skills.map((s) => (typeof s === "string" ? { name: s, level: "" } : { name: s.name || "", level: s.level || "" }));
}

function normalizeLanguages(languages = []) {
  return languages.map((l) => (typeof l === "string" ? { name: l, proficiency: "" } : { name: l.name || "", proficiency: l.proficiency || "" }));
}

/**
 * @param {object} input - minimal user-provided info (see ticket: name,
 *   contact, education, experience, skills, projects, certifications,
 *   languages)
 * @returns {object} a full Resume-shaped payload, ready for
 *   validateResumePayload() + Resume.create()
 */
export function generateResumePayload(input = {}) {
  const {
    fullName, email, phone, location, headline,
    linkedin, github, portfolio, website,
    education = [], experience = [], skills = [],
    projects = [], certifications = [], languages = [],
    template,
  } = input;

  const normalizedExperience = normalizeExperience(experience);

  return {
    title: fullName ? `${fullName}'s Resume` : "Generated Resume",
    template: template || "modern",
    personalInfo: {
      fullName: fullName || "",
      headline: headline || normalizedExperience[0]?.title || "",
      email: email || "",
      phone: phone || "",
      location: location || "",
    },
    summary: generateSummary({ headline, experience: normalizedExperience, skills }),
    experience: normalizedExperience,
    education: education.map((entry) => ({
      school: entry.school || "",
      degree: entry.degree || "",
      field: entry.field || "",
      startDate: entry.startDate || "",
      endDate: entry.endDate || "",
      current: Boolean(entry.current),
      description: entry.description || "",
    })),
    skills: normalizeSkills(skills),
    projects: projects.map((entry) => ({
      name: entry.name || "",
      description: entry.description || "",
      url: entry.url || "",
      technologies: Array.isArray(entry.technologies) ? entry.technologies : [],
    })),
    certifications: certifications.map((entry) => ({
      name: entry.name || "",
      issuer: entry.issuer || "",
      date: entry.date || "",
      url: entry.url || "",
    })),
    languages: normalizeLanguages(languages),
    socialLinks: { linkedin: linkedin || "", github: github || "", portfolio: portfolio || "", website: website || "" },
  };
}
