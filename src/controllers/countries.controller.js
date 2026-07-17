import { getCountryTaxonomyFacets } from "../services/jobQuery.service.js";

/**
 * GET /api/countries
 * Returns [{ name, slug, count }] — the distinct, normalized countries
 * (see utils/countryTaxonomy.js) that currently have at least one
 * active, non-expired job, sorted by count descending. Powers the
 * frontend's searchable country dropdown; nothing here is hardcoded —
 * an empty database correctly returns an empty array, and a country
 * with zero current jobs never appears.
 */
export async function listCountries(req, res, next) {
  try {
    const countries = await getCountryTaxonomyFacets(200);
    res.json(countries);
  } catch (error) {
    next(error);
  }
}
