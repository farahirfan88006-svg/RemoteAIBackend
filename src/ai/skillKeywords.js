/**
 * skillKeywords.js
 * ---------------------------------------------------------------------
 * Canonical skill taxonomy + boundary-safe text matcher, used by
 * atsAnalyzer.js to detect which skills a resume actually mentions.
 *
 * Deliberately the same list/shape/matching approach as the tag
 * normalization already used elsewhere in this codebase
 * (utils/tagTaxonomy.js powers /api/tags from live Job.tags) — this
 * isn't a second, disconnected taxonomy invented for the analyzer; it's
 * meant to recognize the same skill vocabulary the rest of the platform
 * already understands, so "missing skills" can be computed by comparing
 * against real, currently-in-demand tags from the live jobs database
 * (see atsAnalyzer.js#getTopMarketSkills) rather than a hardcoded list.
 * ---------------------------------------------------------------------
 */

const SKILL_TAXONOMY = [
  { name: "Python", slug: "python", aliases: ["python"] },
  { name: "JavaScript", slug: "javascript", aliases: ["javascript", "ecmascript"] },
  { name: "TypeScript", slug: "typescript", aliases: ["typescript"] },
  { name: "Java", slug: "java", aliases: ["java"] },
  { name: "Go", slug: "go", aliases: ["golang"] },
  { name: "Rust", slug: "rust", aliases: ["rust"] },
  { name: "Ruby", slug: "ruby", aliases: ["ruby"] },
  { name: "PHP", slug: "php", aliases: ["php"] },
  { name: "C++", slug: "cpp", aliases: ["c++", "cpp"] },
  { name: "C#", slug: "csharp", aliases: ["c#", "csharp"] },
  { name: "SQL", slug: "sql", aliases: ["sql"] },
  { name: "React", slug: "react", aliases: ["react.js", "reactjs", "react"] },
  { name: "Vue.js", slug: "vuejs", aliases: ["vue.js", "vuejs", "vue"] },
  { name: "Angular", slug: "angular", aliases: ["angular.js", "angularjs", "angular"] },
  { name: "Next.js", slug: "nextjs", aliases: ["next.js", "nextjs"] },
  { name: "HTML", slug: "html", aliases: ["html5", "html"] },
  { name: "CSS", slug: "css", aliases: ["css3", "css"] },
  { name: "Node.js", slug: "nodejs", aliases: ["node.js", "nodejs", "node js"] },
  { name: "Django", slug: "django", aliases: ["django"] },
  { name: "Flask", slug: "flask", aliases: ["flask"] },
  { name: "GraphQL", slug: "graphql", aliases: ["graphql"] },
  { name: "AWS", slug: "aws", aliases: ["aws", "amazon web services"] },
  { name: "Google Cloud", slug: "gcp", aliases: ["gcp", "google cloud"] },
  { name: "Azure", slug: "azure", aliases: ["azure"] },
  { name: "Docker", slug: "docker", aliases: ["docker"] },
  { name: "Kubernetes", slug: "kubernetes", aliases: ["kubernetes", "k8s"] },
  { name: "Terraform", slug: "terraform", aliases: ["terraform"] },
  { name: "CI/CD", slug: "ci-cd", aliases: ["ci/cd", "ci-cd", "cicd"] },
  { name: "PostgreSQL", slug: "postgresql", aliases: ["postgresql", "postgres"] },
  { name: "MySQL", slug: "mysql", aliases: ["mysql"] },
  { name: "MongoDB", slug: "mongodb", aliases: ["mongodb", "mongo"] },
  { name: "Redis", slug: "redis", aliases: ["redis"] },
  { name: "Machine Learning", slug: "machine-learning", aliases: ["machine learning"] },
  { name: "Data Science", slug: "data-science", aliases: ["data science"] },
  { name: "TensorFlow", slug: "tensorflow", aliases: ["tensorflow"] },
  { name: "Git", slug: "git", aliases: ["git"] },
  { name: "Agile", slug: "agile", aliases: ["agile", "scrum"] },
  { name: "Figma", slug: "figma", aliases: ["figma"] },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(entry) {
  const alternation = entry.aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?<![a-zA-Z0-9])(?:${alternation})(?![a-zA-Z0-9])`, "i");
}

const COMPILED = SKILL_TAXONOMY.map((entry) => ({ ...entry, matcher: buildMatcher(entry) }));

/** @param {string} text @returns {{name: string, slug: string}[]} */
export function detectSkillsInText(text) {
  if (!text) return [];
  return COMPILED.filter((entry) => entry.matcher.test(text)).map(({ name, slug }) => ({ name, slug }));
}

export { SKILL_TAXONOMY };
