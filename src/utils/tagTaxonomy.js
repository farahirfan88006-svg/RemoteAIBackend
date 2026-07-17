/**
 * tagTaxonomy.js
 *
 * `Job.tags` (see models/Job.js) already stores clean, lowercase, deduped
 * strings — normalizeTags() in normalizeJobRecord.js handles that at
 * ingestion time. What it does NOT guarantee is a URL-safe slug (a tag can
 * contain spaces, dots, or other punctuation, e.g. "node.js", "machine
 * learning"), so this module is the single place that turns a raw tag
 * value into a `{ name, slug }` pair for the `/api/tags` endpoint —
 * exactly the same role categoryTaxonomy.js plays for categories, just
 * without the alias-matching step (tags are already atomic, unlike
 * provider-supplied department strings).
 *
 * Nothing here talks to MongoDB — pure string in, { name, slug } out.
 */

/** Same slugifier as categoryTaxonomy.js, duplicated locally to avoid a cross-taxonomy dependency for one tiny function. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Title-cases a raw tag for display, e.g. "machine learning" -> "Machine Learning", "ai" -> "AI". */
const UPPERCASE_ACRONYMS = new Set(["ai", "ml", "ux", "ui", "qa", "hr", "seo", "sem", "aws", "gcp", "api", "sql", "nlp"]);

export function humanizeTag(rawTag) {
  const raw = String(rawTag || "").trim();
  if (!raw) return raw;
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (UPPERCASE_ACRONYMS.has(lower)) return lower.toUpperCase();
      // Preserve internal punctuation casing conventions like "Node.js"
      // (capitalize only the first segment; ".js"/".net"-style suffixes
      // conventionally stay lowercase).
      const segments = word.split(/([./-])/);
      return segments
        .map((part, index) => {
          if (/[./-]/.test(part)) return part;
          return index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part.toLowerCase();
        })
        .join("");
    })
    .join(" ");
}

/** @param {string} rawTag @returns {{ name: string, slug: string } | undefined} */
export function normalizeTagEntry(rawTag) {
  const raw = String(rawTag || "").trim();
  if (!raw) return undefined;
  const slug = slugify(raw);
  if (!slug) return undefined;
  return { name: humanizeTag(raw), slug };
}

export { slugify as slugifyTag };
