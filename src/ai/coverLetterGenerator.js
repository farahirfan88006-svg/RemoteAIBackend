import { detectSkillsInText } from "./skillKeywords.js";

/**
 * AI Cover Letter Generator — same "what AI means here" disclosure as
 * resumeGenerator.js/atsAnalyzer.js: template-based text assembly from
 * real resume/job data, not an LLM call.
 *
 * Job-specific mode tailors the letter by finding the overlap between
 * the candidate's resume skills and the job's own text (title +
 * description + tags) via the same `detectSkillsInText` used by the
 * Resume Analyzer — "tailored" here concretely means "leads with the
 * skills that actually match this job", not just interpolating the
 * company name into a fixed template.
 *
 * @param {object} resume - a Resume document (or plain object with the
 *   same shape)
 * @param {object} [job] - { title, companyName, description, tags } —
 *   omit for General mode
 * @returns {string} the full letter body (paragraphs separated by blank lines)
 */
export function generateCoverLetter(resume, job = null) {
  const fullName = resume.personalInfo?.fullName || "Candidate";
  const headline = resume.personalInfo?.headline || "";
  const resumeSkillNames = (resume.skills || []).map((s) => s.name).filter(Boolean);

  const jobText = job ? [job.title, job.description, ...(job.tags || [])].filter(Boolean).join(" ") : "";
  const jobRelevantSkills = job ? detectSkillsInText(jobText).map((s) => s.name) : [];
  // Skills the candidate actually has AND the job actually mentions —
  // the genuinely "tailored" part, not just any of the candidate's skills.
  const matchedSkills = jobRelevantSkills.filter((skill) =>
    resumeSkillNames.some((owned) => owned.toLowerCase() === skill.toLowerCase()),
  );
  const highlightSkills = (matchedSkills.length > 0 ? matchedSkills : resumeSkillNames).slice(0, 4);

  const roleLine = job?.title
    ? `the ${job.title} position${job.companyName ? ` at ${job.companyName}` : ""}`
    : "this opportunity";

  const opening = `I am writing to express my interest in ${roleLine}. ${
    headline ? `As a ${headline}, ` : ""
  }I believe my background and skills make me a strong fit for this role.`;

  const mostRecent = (resume.experience || [])[0];
  const backgroundParagraph = mostRecent
    ? `In my current role${mostRecent.title ? ` as ${mostRecent.title}` : ""}${
        mostRecent.company ? ` at ${mostRecent.company}` : ""
      }, I have developed hands-on experience that I am eager to bring to this position.${
        resume.summary ? ` ${resume.summary}` : ""
      }`
    : resume.summary || "I have built relevant experience and skills that I am excited to bring to this role.";

  const skillsParagraph =
    highlightSkills.length > 0
      ? `${
          matchedSkills.length > 0 ? "This role's requirements closely match my experience with" : "My core strengths include"
        } ${highlightSkills.join(", ")}, which I have applied throughout my career to deliver results.`
      : "";

  const closing = `I would welcome the opportunity to discuss how my background aligns with your needs${
    job?.companyName ? ` at ${job.companyName}` : ""
  }. Thank you for considering my application.`;

  const signOff = `Sincerely,\n${fullName}`;

  return [opening, backgroundParagraph, skillsParagraph, closing, signOff].filter(Boolean).join("\n\n");
}
