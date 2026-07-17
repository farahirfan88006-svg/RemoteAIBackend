import { searchJobs, getJobBySlug } from "../services/jobQuery.service.js";
import { generateInterviewQuestions } from "../ai/interviewQuestions.js";
import { estimateSalary } from "../ai/salaryEstimator.js";
import { parsePagination, buildPaginationMeta } from "../utils/pagination.js";
import { notFoundError } from "../utils/AppError.js";

/**
 * GET /api/jobs
 * Supports: q, category, type, experience, remoteType, location,
 * salaryMin, salaryMax, sort, page, pageSize — all handled by
 * searchJobs(). This handler only wires the request to the service and
 * the response; it holds no filtering logic itself.
 */
export async function listJobs(req, res, next) {
  try {
    const result = await searchJobs(req.query);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/jobs/:slug
 * Powers the job detail page — the single place Apply, interview
 * questions, cover-letter generation, and salary estimate all render.
 */
export async function getJob(req, res, next) {
  try {
    const job = await getJobBySlug(req.params.slug);
    if (!job) throw notFoundError("Job not found.");
    res.json(job);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/jobs/:slug/interview-questions
 * Supports page/pageSize (see utils/pagination.js) — the question bank
 * is generated in one shot (cheap, in-memory, no extra DB queries) and
 * paginated the same way every other list in this API is, rather than
 * inventing a separate pagination convention for this one endpoint.
 */
export async function getInterviewQuestions(req, res, next) {
  try {
    const job = await getJobBySlug(req.params.slug);
    if (!job) throw notFoundError("Job not found.");

    const allQuestions = generateInterviewQuestions(job);
    const { page, pageSize } = parsePagination(req.query);
    const start = (page - 1) * pageSize;
    const questions = allQuestions.slice(start, start + pageSize);

    res.json({
      questions,
      ...buildPaginationMeta({ total: allQuestions.length, page, pageSize }),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/jobs/:slug/salary-estimate
 */
export async function getSalaryEstimate(req, res, next) {
  try {
    const job = await getJobBySlug(req.params.slug);
    if (!job) throw notFoundError("Job not found.");
    res.json(estimateSalary(job));
  } catch (error) {
    next(error);
  }
}
