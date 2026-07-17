import slugify from "slugify";
import Job from "../models/Job.js";
import { buildJobFilter } from "../services/jobQuery.service.js";

/**
 * GET /api/companies
 * Returns [{ name, slug, logo, jobCount }], derived live from whatever
 * companies currently post active, non-expired jobs — reuses
 * `buildJobFilter({})` from the jobs query service so "what counts as a
 * visible job" (isActive + not expired) is defined in exactly one place,
 * not re-implemented here. Nothing is hardcoded; an empty database
 * correctly returns an empty array.
 */
export async function listCompanies(req, res, next) {
  try {
    const baseFilter = { ...buildJobFilter({}), companyName: { $nin: [null, ""] } };

    const rows = await Job.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: "$companyName",
          logo: { $first: "$companyLogo" },
          jobCount: { $sum: 1 },
        },
      },
      { $sort: { jobCount: -1 } },
    ]);

    const companies = rows.map((row) => ({
      name: row._id,
      slug: slugify(row._id, { lower: true, strict: true }),
      logo: row.logo || undefined,
      jobCount: row.jobCount,
    }));

    res.json(companies);
  } catch (error) {
    next(error);
  }
}
