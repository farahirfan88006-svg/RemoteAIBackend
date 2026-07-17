import { getTagTaxonomyFacets } from "../services/jobQuery.service.js";

/**
 * GET /api/tags
 * Returns [{ name, slug, count }] — the distinct tags/skills (see
 * utils/tagTaxonomy.js) that currently have at least one active,
 * non-expired job, sorted by count descending. Powers the programmatic
 * SEO skill landing pages (/remote-python-jobs, /remote-react-jobs, ...)
 * on the frontend — nothing here is hardcoded: an empty database
 * correctly returns an empty array, and a tag with zero current jobs
 * never appears (and its page is simply never generated).
 *
 * Same shape and pattern as /api/categories and /api/countries
 * (categories.controller.js / countries.controller.js) on purpose, so the
 * frontend's taxonomy data layer (lib/api/taxonomy.js) can be extended
 * with a sibling module (lib/api/tags.js) instead of a bespoke shape.
 */
export async function listTags(req, res, next) {
  try {
    const tags = await getTagTaxonomyFacets(200);
    res.json(tags);
  } catch (error) {
    next(error);
  }
}
