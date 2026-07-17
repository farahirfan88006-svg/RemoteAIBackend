import CoverLetter from "../models/CoverLetter.js";
import Resume from "../models/Resume.js";
import { getJobBySlug } from "../services/jobQuery.service.js";
import { generateCoverLetter } from "../ai/coverLetterGenerator.js";
import { badRequest, notFoundError } from "../utils/AppError.js";

/**
 * POST /api/cover-letters/generate
 * Requires auth. Body: { resumeId, jobSlug? }
 *   - General mode: omit jobSlug.
 *   - Job-specific mode: pass the job's slug — reuses the exact same
 *     `getJobBySlug` the job detail page itself uses, so "the job" here
 *     is never a second, parallel notion of a job.
 *
 * Reuses the caller's own Resume document (ownership-checked the same
 * way resumes.controller.js does) as the source of profile data — no
 * separate "profile" model was introduced for this.
 */
export async function generateLetter(req, res, next) {
  try {
    const { resumeId, jobSlug } = req.body || {};
    if (!resumeId) throw badRequest("resumeId is required.", "MISSING_RESUME_ID");

    const resume = await Resume.findOne({ _id: resumeId, owner: req.user._id }).lean();
    if (!resume) throw notFoundError("Resume not found.");

    let job = null;
    if (jobSlug) {
      job = await getJobBySlug(jobSlug);
      if (!job) throw notFoundError("Job not found.");
    }

    const content = generateCoverLetter(resume, job);

    const letter = await CoverLetter.create({
      owner: req.user._id,
      title: job?.title ? `Cover Letter — ${job.title}${job.companyName ? ` at ${job.companyName}` : ""}` : `Cover Letter — ${resume.title}`,
      content,
      job: job ? { slug: job.slug, title: job.title, companyName: job.companyName } : undefined,
    });

    res.status(201).json(letter);
  } catch (error) {
    next(error);
  }
}

/** GET /api/cover-letters — requires auth. */
export async function listLetters(req, res, next) {
  try {
    const letters = await CoverLetter.find({ owner: req.user._id })
      .sort({ updatedAt: -1 })
      .select("title job updatedAt createdAt")
      .lean();
    res.json(letters);
  } catch (error) {
    next(error);
  }
}

/** GET /api/cover-letters/:id — requires auth. */
export async function getLetter(req, res, next) {
  try {
    const letter = await CoverLetter.findOne({ _id: req.params.id, owner: req.user._id });
    if (!letter) throw notFoundError("Cover letter not found.");
    res.json(letter);
  } catch (error) {
    next(error);
  }
}

/** PUT /api/cover-letters/:id — requires auth. Body: { title?, content? } — user-edited text. */
export async function updateLetter(req, res, next) {
  try {
    const { title, content } = req.body || {};
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (content !== undefined) patch.content = content;

    const letter = await CoverLetter.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { $set: patch },
      { new: true, runValidators: true },
    );
    if (!letter) throw notFoundError("Cover letter not found.");
    res.json(letter);
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/cover-letters/:id — requires auth. */
export async function deleteLetter(req, res, next) {
  try {
    const letter = await CoverLetter.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!letter) throw notFoundError("Cover letter not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
