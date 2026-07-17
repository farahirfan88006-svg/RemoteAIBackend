import { detectSkillsInText } from "./skillKeywords.js";

/**
 * AI Interview Questions Generator — same disclosure as the other
 * ai/*.js modules: this is a curated, rule-selected question bank, not
 * an LLM generating novel questions per job. Selection is real and
 * job-specific (which skills/category match), the question text itself
 * comes from a fixed bank.
 *
 * Reuses `detectSkillsInText` (same module the Resume Analyzer and Cover
 * Letter generator use) to find which of the job's mentioned skills this
 * bank has coverage for — one skill-detection implementation shared
 * across all three features, not three copies of similar keyword matching.
 */

const HR_QUESTIONS = [
  { question: "Why are you interested in this role and our company?", suggestedAnswer: "Connect specific parts of the job description/company mission to your own experience and goals — avoid a generic answer that could apply to any employer.", difficulty: "beginner" },
  { question: "Where do you see yourself in 3-5 years?", suggestedAnswer: "Show growth ambition that's realistic for this role/path, and connects to the company's own trajectory.", difficulty: "beginner" },
  { question: "What are your salary expectations?", suggestedAnswer: "Give a researched range (see this platform's Salary Estimator for the role/location) rather than a single fixed number.", difficulty: "beginner" },
  { question: "Why are you leaving your current position?", suggestedAnswer: "Frame it forward-looking (what you're seeking) rather than negatively about your current employer.", difficulty: "beginner" },
  { question: "What's your availability / notice period?", suggestedAnswer: "Be specific and honest — this affects the employer's hiring timeline directly.", difficulty: "beginner" },
];

const BEHAVIORAL_QUESTIONS = [
  { question: "Tell me about a time you disagreed with a teammate or manager. How did you handle it?", suggestedAnswer: "Use the STAR method (Situation, Task, Action, Result) — focus on how you resolved it constructively, not who was 'right'.", difficulty: "intermediate" },
  { question: "Describe a project that didn't go as planned. What did you learn?", suggestedAnswer: "Own your part honestly, then emphasize the concrete change you made afterward.", difficulty: "intermediate" },
  { question: "Tell me about a time you had to learn something new quickly.", suggestedAnswer: "Show your learning process (how you find information, who you ask, how you validate understanding), not just the outcome.", difficulty: "beginner" },
  { question: "Describe a time you had to manage multiple priorities under a tight deadline.", suggestedAnswer: "Focus on how you decided what to prioritize and communicated tradeoffs, not just that you 'worked hard'.", difficulty: "intermediate" },
  { question: "Tell me about a time you received difficult feedback. How did you respond?", suggestedAnswer: "Show you can receive feedback without defensiveness and describe the specific behavior change that followed.", difficulty: "intermediate" },
];

const TECHNICAL_BY_SKILL = {
  python: [
    { question: "What's the difference between a list and a tuple in Python?", suggestedAnswer: "Lists are mutable; tuples are immutable. Tuples can be used as dict keys/set members as a result, lists cannot.", difficulty: "beginner" },
    { question: "Explain Python's GIL (Global Interpreter Lock) and its impact on multithreading.", suggestedAnswer: "Only one thread executes Python bytecode at a time; CPU-bound work doesn't parallelize via threads, but I/O-bound work still benefits, and multiprocessing sidesteps it.", difficulty: "advanced" },
  ],
  javascript: [
    { question: "Explain the difference between var, let, and const.", suggestedAnswer: "var is function-scoped and hoisted with no TDZ; let/const are block-scoped with a temporal dead zone; const additionally disallows reassignment.", difficulty: "beginner" },
    { question: "What is a closure, and give a practical use case.", suggestedAnswer: "A function retaining access to its defining scope's variables after that scope has exited — common uses: private state, memoization, event handler factories.", difficulty: "intermediate" },
  ],
  typescript: [
    { question: "What's the difference between interface and type in TypeScript?", suggestedAnswer: "Interfaces can be merged/extended and are generally preferred for object shapes; types can express unions/intersections/primitives that interfaces can't.", difficulty: "intermediate" },
  ],
  react: [
    { question: "What problem do React hooks solve compared to class components?", suggestedAnswer: "Reusable stateful logic without wrapper-component hierarchies (HOCs/render props), and colocating related logic instead of splitting it across lifecycle methods.", difficulty: "intermediate" },
    { question: "How does React's reconciliation (virtual DOM diffing) work at a high level?", suggestedAnswer: "React builds a virtual DOM tree, diffs it against the previous render using keys to match elements, and applies only the minimal set of real DOM mutations needed.", difficulty: "advanced" },
  ],
  nodejs: [
    { question: "How does Node.js handle concurrency given it's single-threaded?", suggestedAnswer: "An event loop plus non-blocking I/O — CPU work blocks the loop, but I/O (disk/network) is delegated and its callback runs later without blocking other work.", difficulty: "intermediate" },
  ],
  sql: [
    { question: "What's the difference between an INNER JOIN and a LEFT JOIN?", suggestedAnswer: "INNER JOIN returns only matching rows in both tables; LEFT JOIN returns all rows from the left table, with NULLs for unmatched right-side columns.", difficulty: "beginner" },
    { question: "How would you find and fix a slow query?", suggestedAnswer: "Use EXPLAIN/ANALYZE to see the query plan, check for missing indexes on filtered/joined columns, and watch for full table scans.", difficulty: "intermediate" },
  ],
  aws: [
    { question: "What's the difference between an EC2 instance and a Lambda function?", suggestedAnswer: "EC2 is a persistent VM you manage and pay for continuously; Lambda is event-driven, ephemeral, and billed per invocation/duration — good for bursty, stateless workloads.", difficulty: "intermediate" },
  ],
  docker: [
    { question: "What's the difference between a Docker image and a container?", suggestedAnswer: "An image is the immutable build artifact/template; a container is a running (or stopped) instance of that image with its own writable layer.", difficulty: "beginner" },
  ],
  kubernetes: [
    { question: "What's the difference between a Deployment and a StatefulSet?", suggestedAnswer: "Deployments manage interchangeable, stateless pod replicas; StatefulSets give each pod a stable identity/ordinal and stable storage — needed for stateful workloads like databases.", difficulty: "advanced" },
  ],
  "machine-learning": [
    { question: "Explain the bias-variance tradeoff.", suggestedAnswer: "High bias underfits (too simple a model), high variance overfits (too sensitive to training data) — the goal is the sweet spot that generalizes to unseen data.", difficulty: "intermediate" },
  ],
  "data-science": [
    { question: "How do you handle missing data in a dataset?", suggestedAnswer: "Depends on missingness pattern and amount — options include deletion, mean/median/mode imputation, model-based imputation, or flagging missingness as its own feature.", difficulty: "intermediate" },
  ],
  git: [
    { question: "What's the difference between git merge and git rebase?", suggestedAnswer: "Merge preserves both histories and creates a merge commit; rebase replays commits onto a new base, producing a linear history but rewriting commit hashes.", difficulty: "intermediate" },
  ],
};

const CODING_BY_SKILL = {
  python: [{ question: "Write a function that returns the first non-repeating character in a string.", suggestedAnswer: "A common approach: count character frequencies in one pass (e.g. a dict/Counter), then scan again in order and return the first with count 1 — O(n) time.", difficulty: "intermediate" }],
  javascript: [{ question: "Write a function that flattens a nested array to a given depth.", suggestedAnswer: "Recursively check each element; if it's an array and depth > 0, recurse with depth - 1 and spread the result, otherwise push the element as-is.", difficulty: "intermediate" }],
  java: [{ question: "Write a method to check whether a string is a palindrome, ignoring case and non-alphanumeric characters.", suggestedAnswer: "Strip non-alphanumeric characters, lowercase, then compare the string to its reverse (or use two pointers from both ends).", difficulty: "beginner" }],
  sql: [{ question: "Write a query to find the second-highest salary in an employees table.", suggestedAnswer: "Common approaches: SELECT MAX(salary) FROM employees WHERE salary < (SELECT MAX(salary) FROM employees), ORDER BY salary DESC LIMIT 1 OFFSET 1, or a window function like DENSE_RANK().", difficulty: "intermediate" }],
  go: [{ question: "Write a function that detects a cycle in a linked list.", suggestedAnswer: "Floyd's cycle detection (slow/fast pointers) — if they ever meet, there's a cycle; if the fast pointer reaches the end, there isn't.", difficulty: "intermediate" }],
};

const PROGRAMMING_LANGUAGE_SKILLS = new Set(["python", "javascript", "typescript", "java", "go", "sql", "ruby", "php", "cpp", "csharp"]);

const TECHNICAL_BY_CATEGORY_FALLBACK = {
  "software-engineering": [{ question: "Walk me through how you'd design a URL shortener.", suggestedAnswer: "Cover the hash/encoding scheme for short codes, the data store and its read/write pattern, collision handling, and how you'd scale reads (caching) vs writes.", difficulty: "advanced" }],
  "product-design": [{ question: "Walk me through your design process from brief to handoff.", suggestedAnswer: "Cover research/discovery, how you validate direction (wireframes, prototypes, user testing), and how you collaborate with engineering at handoff.", difficulty: "intermediate" }],
  marketing: [{ question: "How would you measure the success of a marketing campaign?", suggestedAnswer: "Tie metrics to the campaign's actual goal (awareness vs. conversion vs. retention) rather than defaulting to vanity metrics like impressions alone.", difficulty: "intermediate" }],
  sales: [{ question: "Walk me through how you qualify a lead.", suggestedAnswer: "A framework like BANT/MEDDIC — budget, authority, need, timeline — and how you'd disqualify early to focus effort on winnable deals.", difficulty: "intermediate" }],
  "product-management": [{ question: "How do you prioritize a product backlog with limited engineering resources?", suggestedAnswer: "A framework (e.g. RICE/impact-effort) tied to business goals, and how you communicate tradeoffs/what's NOT being done to stakeholders.", difficulty: "advanced" }],
  "customer-support": [{ question: "How would you handle an angry customer who feels they've been wronged?", suggestedAnswer: "Acknowledge the emotion first, then focus on what's actually fixable — de-escalation before problem-solving.", difficulty: "beginner" }],
};

const DEFAULT_TECHNICAL_FALLBACK = [
  { question: "What tools or methods do you rely on most in your day-to-day work?", suggestedAnswer: "Be specific about actual tools/workflows relevant to this role, not a generic list.", difficulty: "beginner" },
];

/**
 * @param {{ title?: string, description?: string, category?: string, tags?: string[] }} job
 * @returns {{ question: string, suggestedAnswer: string, difficulty: string, section: string }[]}
 */
export function generateInterviewQuestions(job) {
  const jobText = [job.title, job.description, ...(job.tags || [])].filter(Boolean).join(" ");
  const detectedSkills = detectSkillsInText(jobText).slice(0, 4);

  const questions = [];

  const technicalFromSkills = detectedSkills.flatMap((skill) => TECHNICAL_BY_SKILL[skill.slug] || []);
  const technical = technicalFromSkills.length > 0
    ? technicalFromSkills
    : TECHNICAL_BY_CATEGORY_FALLBACK[job.category] || DEFAULT_TECHNICAL_FALLBACK;
  questions.push(...technical.map((q) => ({ ...q, section: "technical" })));

  questions.push(...HR_QUESTIONS.map((q) => ({ ...q, section: "hr" })));
  questions.push(...BEHAVIORAL_QUESTIONS.map((q) => ({ ...q, section: "behavioral" })));

  const codingQuestions = detectedSkills
    .filter((skill) => PROGRAMMING_LANGUAGE_SKILLS.has(skill.slug))
    .flatMap((skill) => CODING_BY_SKILL[skill.slug] || []);
  if (codingQuestions.length > 0) {
    questions.push(...codingQuestions.map((q) => ({ ...q, section: "coding" })));
  }

  return questions;
}
