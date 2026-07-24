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
 * On top of that skill-matching, this version:
 *   - Pulls concrete achievements from the candidate's most relevant
 *     experience entry, projects, and awards (when present) instead of
 *     only naming skills in the abstract.
 *   - Infers a rough "job type" (startup / enterprise / remote /
 *     technical / marketing / general) from the job's title, tags, and
 *     description, and shifts sentence choices accordingly — a startup
 *     role reads leaner and more energetic, an enterprise role reads
 *     more measured and outcomes-focused, etc.
 *   - Picks between a small set of non-cliché phrasings for each
 *     paragraph (opening, motivation, closing) using a deterministic
 *     selector derived from the input itself, so the same
 *     resume+job always produces the same letter (stable for caching /
 *     re-generation) while different resumes/jobs don't all read like
 *     the same boilerplate.
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

  const jobType = detectJobType(jobText);
  const pick = makeDeterministicPicker(`${fullName}|${job?.title || ""}|${job?.companyName || ""}`);

  const roleLine = job?.title
    ? `the ${job.title} position${job.companyName ? ` at ${job.companyName}` : ""}`
    : "this opportunity";

  const mostRecent = (resume.experience || [])[0];
  const topProject = (resume.projects || [])[0];
  const topAward = (resume.awards || [])[0];

  const opening = buildOpening({ headline, roleLine, jobType, pick });
  const backgroundParagraph = buildBackgroundParagraph({
    mostRecent,
    topProject,
    summary: resume.summary,
    jobType,
    pick,
  });
  const skillsParagraph = buildSkillsParagraph({
    highlightSkills,
    matchedSkills,
    topAward,
    jobTitle: job?.title,
    jobType,
    pick,
  });
  const motivationParagraph = job?.companyName
    ? buildMotivationParagraph({ companyName: job.companyName, jobType, pick })
    : "";
  const closing = buildClosing({ companyName: job?.companyName, jobType, pick });
  const signOff = `Sincerely,\n${fullName}`;

  return [opening, backgroundParagraph, skillsParagraph, motivationParagraph, closing, signOff]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Small, dependency-free deterministic hash-based picker: same seed always
 * returns the same index into a given options array. Lets each paragraph
 * choose among a handful of natural, non-repetitive phrasings without
 * relying on Math.random() (which would make output non-reproducible and
 * cache-unfriendly), and without every letter reading like a copy-paste of
 * the last one.
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
 * Infers a rough job-type category from the job's combined text so tone
 * and word choice can shift accordingly — e.g. "fast-paced, wear-many-hats"
 * language for a startup role vs. "process, scale, cross-functional"
 * language for an enterprise role. Falls back to "general" when no
 * category's keywords clearly show up.
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

  // Order matters: more specific categories are checked before the very
  // broad "technical" bucket so a "Marketing Engineer" role, for example,
  // still reads as marketing-flavored rather than purely technical.
  for (const type of ["startup", "enterprise", "remote", "marketing", "technical"]) {
    if (KEYWORD_GROUPS[type].some((kw) => text.includes(kw))) return type;
  }
  return "general";
}

/**
 * Joins an optional leading clause (e.g. "As a Senior Engineer, ") with a
 * sentence written in lowercase-first form, capitalizing correctly either
 * way: if there's a clause, the sentence continues it mid-sentence (stays
 * lowercase); if there isn't, the sentence starts fresh (gets capitalized).
 * Avoids a class of bugs where capitalization was hard-coded assuming the
 * clause was/wasn't present.
 *
 * @param {string} clause - e.g. "As a Senior Engineer, " (or "")
 * @param {string} sentence - written lowercase-first, e.g. "reading through the role..."
 * @returns {string}
 */
function withClause(clause, sentence) {
  return clause ? `${clause}${lowercaseFirst(sentence)}` : capitalize(sentence);
}

function buildOpening({ headline, roleLine, jobType, pick }) {
  const roleClause = headline ? `As a ${headline}, ` : "";

  const openers = {
    startup: [
      `I'm reaching out about ${roleLine} — the chance to help build something from the ground up is exactly the kind of challenge I'm looking for.`,
      withClause(roleClause, `I'm excited to apply for ${roleLine}; I like moving fast and owning outcomes, and this role looks built for exactly that.`),
    ],
    enterprise: [
      `I'm writing to apply for ${roleLine}. ${withClause(roleClause, `I'm drawn to the scale of impact a role like this can have across a large organization.`)}`,
      withClause(roleClause, `I'm applying for ${roleLine}, having spent my career delivering results in structured, cross-functional environments like this one.`),
    ],
    remote: [
      `I'm applying for ${roleLine}. ${withClause(roleClause, `I've built my career working independently and communicating clearly across distributed teams, which this role clearly values.`)}`,
      withClause(roleClause, `I'm excited about ${roleLine} — remote-first work is where I do my best, most focused work, and I'd like to bring that here.`),
    ],
    marketing: [
      `I'm applying for ${roleLine}. ${withClause(roleClause, `telling a clear, compelling story is what I do best, and I'd love to do it for your audience.`)}`,
      withClause(roleClause, `${roleLine} caught my attention immediately — I enjoy building the narrative behind a brand people actually remember.`),
    ],
    technical: [
      `I'm applying for ${roleLine}. ${withClause(roleClause, `I enjoy solving hard technical problems, and this role looks like a strong match for how I like to work.`)}`,
      withClause(roleClause, `I'm writing to apply for ${roleLine}; building reliable, well-engineered systems is what drew me to this posting.`),
    ],
    general: [
      `I'm applying for ${roleLine}. ${withClause(roleClause, `reading through the role, my background lines up closely with what you're looking for.`)}`,
      withClause(roleClause, `I'm excited to submit my application for ${roleLine} — it's a strong match for both my experience and what I want to do next.`),
    ],
  };

  return pick(openers[jobType] || openers.general);
}

function buildBackgroundParagraph({ mostRecent, topProject, summary, jobType, pick }) {
  const roleContext = mostRecent
    ? `as ${mostRecent.title || "a professional"}${mostRecent.company ? ` at ${mostRecent.company}` : ""}`
    : null;

  const projectSentence = topProject?.name
    ? ` One project I'm particularly proud of is ${topProject.name}${
        topProject.description ? `, where ${lowercaseFirst(trimToSentence(topProject.description))}` : ""
      }.`
    : "";

  if (!roleContext && !summary) {
    return `I've built relevant, hands-on experience and skills that translate directly into this role.${projectSentence}`;
  }

  const templates = {
    startup: [
      `Most recently, I worked ${roleContext || "in a similar capacity"}, where I moved fast, took ownership beyond my job title, and shipped work that mattered.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
    enterprise: [
      `Most recently, I worked ${roleContext || "in a comparable role"}, delivering measurable results while coordinating across multiple teams and stakeholders.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
    remote: [
      `Most recently, I worked ${roleContext || "in a similar role"}, managing my own priorities and collaborating asynchronously with a distributed team.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
    marketing: [
      `Most recently, I worked ${roleContext || "in a similar role"}, where I helped shape and tell a brand's story across multiple channels.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
    technical: [
      `Most recently, I worked ${roleContext || "in a similar role"}, where I designed and shipped production systems end to end.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
    general: [
      `Most recently, I worked ${roleContext || "in a similar capacity"}, where I developed hands-on experience I'm eager to bring to this role.${
        summary ? ` ${summary}` : ""
      }${projectSentence}`,
    ],
  };

  return pick(templates[jobType] || templates.general);
}

function buildSkillsParagraph({ highlightSkills, matchedSkills, topAward, jobTitle, jobType, pick }) {
  if (highlightSkills.length === 0 && !topAward?.title) return "";

  const skillsClause =
    highlightSkills.length > 0
      ? matchedSkills.length > 0
        ? `what stood out to me in this posting is how closely it lines up with my hands-on work in ${formatList(highlightSkills)}`
        : `my core strengths are in ${formatList(highlightSkills)}`
      : "";

  const awardClause = topAward?.title
    ? `${skillsClause ? " I've also been recognized for this work" : "I've been recognized for this work"}${
        topAward.issuer ? ` — ${topAward.title} from ${topAward.issuer}` : ` — ${topAward.title}`
      }.`
    : "";

  const roleRef = jobTitle ? ` to this ${jobTitle} role` : " to this role";

  const templates = {
    startup: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I'm ready to put that directly to work${roleRef} from day one.`],
    enterprise: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I bring that same rigor and consistency${roleRef}.`],
    remote: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I'm looking forward to applying that experience${roleRef} in a remote setting.`],
    marketing: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I'd bring that same eye for what resonates${roleRef}.`],
    technical: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I'm eager to apply that depth${roleRef}.`],
    general: [`${skillsClause ? capitalize(skillsClause) + "." : ""}${awardClause} I'm confident I can apply that experience${roleRef} effectively.`],
  };

  return pick(templates[jobType] || templates.general).trim();
}

function buildMotivationParagraph({ companyName, jobType, pick }) {
  const templates = {
    startup: [
      `What draws me to ${companyName} is the size of the problem you're taking on and the room to actually shape how it gets solved. I'd rather build something meaningful with a small, high-trust team than optimize an already-solved process.`,
      `${companyName} stands out to me for the pace and ownership on offer — I want a role where my decisions visibly move the product forward, not just my task list.`,
    ],
    enterprise: [
      `${companyName}'s scale and reputation are a big part of the appeal — I want my work to hold up under real scrutiny and reach a large, established user base.`,
      `What appeals to me about ${companyName} is the chance to contribute to an organization with established processes and a track record I can learn from and add to.`,
    ],
    remote: [
      `${companyName}'s remote-first approach fits how I work best — heads-down, self-directed, and communicating deliberately rather than relying on hallway conversations.`,
      `I'm drawn to ${companyName} because remote-first isn't an afterthought there; it's clearly built into how the team operates, and that matches how I do my best work.`,
    ],
    marketing: [
      `${companyName}'s brand voice and positioning are genuinely something I admire, and I'd welcome the chance to help sharpen that story further.`,
      `What draws me to ${companyName} is the audience you've built — I'd like to help keep that relationship growing with work that actually lands.`,
    ],
    technical: [
      `${companyName}'s engineering challenges are exactly the kind of problems I find energizing to work on, and I'd welcome the chance to dig into them.`,
      `What appeals to me about ${companyName} is the technical bar you clearly hold your team to — that's the environment I want to be pushed by.`,
    ],
    general: [
      `What draws me to ${companyName} specifically is the opportunity to contribute to a team and mission I respect, and to grow alongside it.`,
      `${companyName} stood out to me while researching this role, and I'd welcome the chance to contribute to what your team is building.`,
    ],
  };

  return pick(templates[jobType] || templates.general);
}

function buildClosing({ companyName, jobType, pick }) {
  const at = companyName ? ` at ${companyName}` : "";

  const templates = {
    startup: [`I'd welcome a conversation about where I could make the fastest impact${at}. Thanks for taking the time to review my application — I hope to talk soon.`],
    enterprise: [`I'd appreciate the opportunity to discuss how my background fits your team's needs${at}. Thank you for your time and consideration.`],
    remote: [`I'd be glad to talk through how I could contribute to your distributed team${at}. Thank you for considering my application.`],
    marketing: [`I'd love the chance to talk through some early ideas for your next campaign${at}. Thanks for reviewing my application.`],
    technical: [`I'd welcome the opportunity to dig into the technical details of the role${at}. Thank you for considering my application.`],
    general: [`I'd welcome the opportunity to discuss how my background aligns with your needs${at}. Thank you for considering my application.`],
  };

  return pick(templates[jobType] || templates.general);
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

function lowercaseFirst(text) {
  if (!text) return text;
  // The pronoun "I" (standalone, or in a contraction like "I'm"/"I've"/"I'd")
  // is always capitalized in English regardless of sentence position, so
  // leave it untouched rather than producing "i'm"/"i've".
  if (/^I(?:['’]|\s|$)/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Trims a longer description down to a single clean sentence for inline use. */
function trimToSentence(text) {
  const trimmed = (text || "").trim();
  const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] || trimmed;
  return firstSentence.replace(/[.!?]+$/, "");
}
