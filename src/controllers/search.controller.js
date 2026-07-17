import { searchJobs } from "../services/jobQuery.service.js";

/**
 * GET /api/search
 * Same query params and response shape as GET /api/jobs — this endpoint
 * exists as a dedicated search surface, but it calls the identical
 * `searchJobs()` service function rather than re-implementing any part of
 * filtering, sorting, or pagination.
 */
export async function search(req, res, next) {
  try {
    const result = await searchJobs(req.query);
    res.json(result);
  } catch (error) {
    next(error);
  }
}
