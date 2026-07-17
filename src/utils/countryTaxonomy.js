/**
 * countryTaxonomy.js
 *
 * Providers report the same country under many spellings ("USA", "US",
 * "United States", "U.S.A."), and "no specific country" listings under
 * several different labels ("Remote", "Worldwide", "Global", "Anywhere").
 * This module normalizes a raw provider-supplied country/location string
 * into one consistent canonical country name.
 *
 * Unlike categories (a closed, curated set), most real country names are
 * already their own canonical form (e.g. "Germany", "India") — so this
 * only needs an alias table for the handful of countries with common
 * irregular variants, plus the "remote/worldwide" bucket. Anything that
 * doesn't match an alias is title-cased and used as-is: normalization
 * here means "collapse known duplicates", not "force everything into a
 * fixed list" (a fixed list would silently drop real countries that
 * simply weren't anticipated).
 *
 * Used by normalizeJobRecord.js at ingestion time and re-exported for
 * the optional backfill script (scripts/backfillTaxonomy.js).
 */

/**
 * Canonical country name -> aliases (lowercase, exact-match). Aliases are
 * matched against the *whole* trimmed raw value, not substrings — country
 * names appear in free-text location fields too often for substring
 * matching to be safe (e.g. "Georgia" the country vs. "Georgia" the US
 * state).
 */
const COUNTRY_ALIASES = {
  Worldwide: [
    "remote", "worldwide", "global", "anywhere", "fully remote", "remote - worldwide",
    "remote (worldwide)", "remote / worldwide", "international", "n/a", "not specified",
  ],
  "United States": [
    "usa", "us", "u.s.", "u.s.a.", "united states", "united states of america", "america",
  ],
  "United Kingdom": ["uk", "u.k.", "united kingdom", "england", "britain", "great britain", "scotland", "wales", "northern ireland"],
  "United Arab Emirates": ["uae", "u.a.e.", "united arab emirates"],
  "South Korea": ["south korea", "korea, republic of", "republic of korea"],
  "Czech Republic": ["czech republic", "czechia"],
  Russia: ["russia", "russian federation"],
  Vietnam: ["vietnam", "viet nam"],
  Netherlands: ["netherlands", "the netherlands", "holland"],
  "United States Minor Outlying Islands": ["us minor outlying islands"],
};

// Build a flat lowercase-alias -> canonical-name lookup once at module load.
const ALIAS_LOOKUP = new Map();
Object.entries(COUNTRY_ALIASES).forEach(([canonical, aliases]) => {
  aliases.forEach((alias) => ALIAS_LOOKUP.set(alias, canonical));
  // The canonical name itself should also resolve to itself.
  ALIAS_LOOKUP.set(canonical.toLowerCase(), canonical);
});

/** Simple, dependency-free slugifier consistent with the rest of the backend. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(value) {
  return String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Normalizes a raw, provider-supplied country string into a canonical
 * display name (e.g. "usa" / "US" / "United States of America" all ->
 * "United States").
 *
 * @param {string|undefined|null} rawCountry
 * @returns {string|undefined} undefined only when `rawCountry` is empty.
 */
export function normalizeCountryName(rawCountry) {
  const raw = String(rawCountry || "").trim();
  if (!raw) return undefined;

  const key = raw.toLowerCase().replace(/\s+/g, " ");
  const aliasHit = ALIAS_LOOKUP.get(key);
  if (aliasHit) return aliasHit;

  // Not a known alias — keep the real country name, just consistently cased.
  return titleCase(raw);
}

/**
 * Same normalization as `normalizeCountryName`, plus its slug — mirrors
 * the { name, slug } shape `normalizeCategory` returns, for callers that
 * want both (e.g. the countries facet aggregation).
 *
 * @param {string|undefined|null} rawCountry
 * @returns {{ name: string, slug: string } | undefined}
 */
export function normalizeCountry(rawCountry) {
  const name = normalizeCountryName(rawCountry);
  if (!name) return undefined;
  return { name, slug: slugify(name) };
}
