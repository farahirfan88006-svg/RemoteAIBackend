import { getCategoryTaxonomyFacets } from "../services/jobQuery.service.js";

/**
 * GET /api/categories
 * Returns [{ name, slug, count }] — the distinct, normalized categories
 * (see utils/categoryTaxonomy.js) that currently have at least one
 * active, non-expired job, sorted by count descending. Powers the
 * frontend's searchable category dropdown; nothing here is hardcoded —
 * an empty database correctly returns an empty array, and a category
 * with zero current jobs never appears.
 *
 * Note: this changes this endpoint's response shape from the earlier
 * `{ value, label, count }` to `{ name, slug, count }` per the dynamic
 * category/country filtering spec. `/api/jobs` and `/api/search`'s
 * `facets.categories` field is untouched and keeps its original shape
 * (see getCategoryFacets in jobQuery.service.js) — nothing in the
 * frontend currently reads from this endpoint directly, so this is safe.
 */
export async function listCategories(req, res, next) {
  try {
    const categories = await getCategoryTaxonomyFacets(200);
    res.json(categories);
  } catch (error) {
    next(error);
  }
}
