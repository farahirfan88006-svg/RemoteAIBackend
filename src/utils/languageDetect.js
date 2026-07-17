/**
 * languageDetect.js
 *
 * Lightweight, dependency-free heuristic for deciding whether a chunk of
 * job-posting text (title + summary) is English, so normalizeJobRecord.js
 * can drop non-English listings before they ever reach dedupe/upsert.
 *
 * This is intentionally NOT a full statistical language-ID model (no
 * external package, no training data bundled) — it's tuned for the
 * specific job this project needs: cheaply telling English apart from
 * German / French / Spanish / Italian / Dutch / Portuguese job ads (the
 * languages that actually show up in EU-heavy feeds like Arbeitnow and
 * Himalayas), plus a fast, reliable catch-all for anything written in a
 * non-Latin script (Cyrillic, CJK, Hangul, Arabic, Devanagari, ...).
 *
 * Two independent signals, either of which is enough to reject a job:
 *
 *   1. Script check — if the text contains a meaningful number of
 *      characters from a non-Latin script, it's non-English, full stop.
 *      This covers "or other non-English languages" generically without
 *      needing a stopword list for every language on earth.
 *
 *   2. Stopword/marker check — for Latin-script European languages that
 *      are hard to tell apart from English by script alone, count how
 *      many function words from each language's stopword list appear,
 *      plus a couple of unmistakable job-ad markers (e.g. the German
 *      "(m/w/d)" gender-disclosure suffix). If a non-English language's
 *      score clearly beats English's, the text is rejected.
 *
 * Deliberately conservative: short, ambiguous, or stopword-free text
 * (e.g. a bare title like "DevOps Engineer") is classified as English by
 * default rather than risking false positives against real English job
 * ads that happen to be short.
 */

// Characters outside these scripts are far more likely to signal "not
// English" than a mis-tokenized English word ever would be.
const NON_LATIN_SCRIPT_RE =
  /[\u0400-\u04FF\u0370-\u03FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3]/;

// Small, high-signal function-word lists per language. These favor
// words that essentially never appear in English text (articles,
// conjunctions, prepositions, pronouns) over generic vocabulary, to
// keep false positives low.
const STOPWORDS = {
  en: new Set([
    "the", "and", "of", "to", "in", "is", "for", "with", "on", "this",
    "that", "or", "are", "we", "you", "our", "will", "be", "as", "at",
    "by", "from", "have", "has", "it", "its", "your", "about", "join",
    "team", "role", "looking", "remote", "work", "experience", "who",
  ]),
  de: new Set([
    "und", "der", "die", "das", "mit", "für", "von", "ist", "auf", "wir",
    "sie", "eine", "einen", "nicht", "im", "zu", "den", "des", "dem",
    "als", "bei", "werden", "sind", "haben", "unser", "unsere", "suchen",
    "gesucht", "sowie", "durch",
  ]),
  fr: new Set([
    "le", "la", "les", "des", "et", "de", "pour", "dans", "est", "vous",
    "nous", "une", "un", "avec", "au", "aux", "du", "notre", "recherche",
    "poste", "équipe", "sont", "chez", "sur", "être",
  ]),
  es: new Set([
    "el", "la", "los", "las", "de", "y", "para", "con", "en", "es", "un",
    "una", "nuestro", "nuestra", "somos", "buscamos", "empresa", "equipo",
    "usted", "estamos", "sobre",
  ]),
  it: new Set([
    "il", "lo", "la", "gli", "di", "per", "con", "che", "un", "una",
    "sono", "siamo", "nostro", "nostra", "cerchiamo", "azienda", "team",
    "dei", "delle", "questo",
  ]),
  nl: new Set([
    "de", "het", "een", "van", "en", "voor", "met", "is", "wij", "niet",
    "op", "onze", "zoeken", "vacature", "bij", "als", "worden", "naar",
  ]),
  pt: new Set([
    "o", "a", "os", "as", "de", "e", "para", "com", "em", "um", "uma",
    "nosso", "nossa", "somos", "procuramos", "empresa", "equipe", "você",
  ]),
};

// Unmistakable non-English job-ad markers worth a big score bump on
// their own, since they show up even in otherwise short/sparse titles
// (e.g. "Vertrieb (m/w/d)" has no German stopwords at all).
const MARKER_BONUSES = [
  { re: /\(?\b[mwd]\/[mwd]\/[mwd]\b\)?/i, lang: "de", bonus: 5 }, // (m/w/d), (w/m/d)
  { re: /\bgmbh\b/i, lang: "de", bonus: 2 },
  { re: /\b(h\/f)\b/i, lang: "fr", bonus: 4 }, // (h/f) — homme/femme
  { re: /\bcdi\b|\bcdd\b/i, lang: "fr", bonus: 3 }, // French contract-type abbreviations
];

const MIN_FOREIGN_STOPWORD_HITS = 3;

function tokenize(text) {
  return text
    .normalize("NFC")
    .toLowerCase()
    .match(/[a-zà-öø-ÿ]+/g) || [];
}

/**
 * @param {string} text - raw text to classify (title + summary/description)
 * @returns {{ isEnglish: boolean, language: string }}
 */
export function detectLanguage(text) {
  const value = String(text || "").trim();
  if (!value) return { isEnglish: true, language: "en" };

  if (NON_LATIN_SCRIPT_RE.test(value)) {
    return { isEnglish: false, language: "other" };
  }

  const tokens = tokenize(value);
  const scores = {};
  for (const [lang, words] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const token of tokens) {
      if (words.has(token)) score += 1;
    }
    scores[lang] = score;
  }

  for (const { re, lang, bonus } of MARKER_BONUSES) {
    if (re.test(value)) scores[lang] += bonus;
  }

  const enScore = scores.en;
  let bestOtherLang = "en";
  let bestOtherScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (lang === "en") continue;
    if (score > bestOtherScore) {
      bestOtherScore = score;
      bestOtherLang = lang;
    }
  }

  const isNonEnglish = bestOtherScore >= MIN_FOREIGN_STOPWORD_HITS && bestOtherScore > enScore;

  return isNonEnglish ? { isEnglish: false, language: bestOtherLang } : { isEnglish: true, language: "en" };
}

/**
 * Convenience boolean wrapper around detectLanguage — this is the only
 * export normalizeJobRecord.js needs.
 * @param {string} text
 * @returns {boolean}
 */
export function isEnglishText(text) {
  return detectLanguage(text).isEnglish;
}
