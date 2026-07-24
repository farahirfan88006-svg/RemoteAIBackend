import mongoose from "mongoose";
import SavedJob from "../models/SavedJob.js";
import Job from "../models/Job.js";
import { badRequest, notFoundError } from "../utils/AppError.js";

/**
 * Saved Jobs — bookmark/unbookmark, following the same
 * owner-scoped-document pattern as coverLetters.controller.js.
 *
 * Body/params identify the target job by its Mongo id (`jobId`),
 * which is what the frontend's normalizeJob already exposes as
 * `job.id` on every job it renders — no separate lookup needed on
 * the frontend before calling save/unsave.
 */

const JOB_SNAPSHOT_FIELDS = [
  "slug",
  "title",
  "companyName",
  "companyLogo",
  "location",
  "country",
  "remoteType",
  "employmentType",
  "experienceLevel",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "category",
  "tags",
  "sourceUrl",
  "datePosted",
];

function buildJobSnapshot(jobDoc) {
  const snapshot = {};
  for (const field of JOB_SNAPSHOT_FIELDS) {
    if (jobDoc[field] !== undefined) snapshot[field] = jobDoc[field];
  }
  return snapshot;
}

/** GET /api/saved-jobs — requires auth. Most recently saved first. */
export async function listSavedJobs(req, res, next) {
  try {
    const savedJobs = await SavedJob.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(savedJobs);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/saved-jobs/ids — requires auth.
 * Lightweight lookup so job cards across the site (grid, search
 * results, job detail) can show saved state without pulling the full
 * saved-job documents/snapshots.
 */
export async function listSavedJobIds(req, res, next) {
  try {
    const savedJobs = await SavedJob.find({ owner: req.user._id }).select("job").lean();
    res.json(savedJobs.map((entry) => String(entry.job)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/saved-jobs — requires auth. Body: { jobId }. Idempotent: re-saving an already-saved job just returns the existing record. */
export async function saveJob(req, res, next) {
  try {
    const { jobId } = req.body || {};
    if (!jobId || !mongoose.isValidObjectId(jobId)) {
      throw badRequest("A valid jobId is required.", "MISSING_JOB_ID");
    }

    const existing = await SavedJob.findOne({ owner: req.user._id, job: jobId });
    if (existing) return res.status(200).json(existing);

    const job = await Job.findById(jobId).lean();
    if (!job) throw notFoundError("Job not found.");

    const savedJob = await SavedJob.create({
      owner: req.user._id,
      job: jobId,
      jobSnapshot: buildJobSnapshot(job),
    });
    res.status(201).json(savedJob);
  } catch (error) {
    // DB-level unique index as a safety net against a race between the
    // findOne check above and this create (see model's compound index).
    if (error?.code === 11000) {
      const existing = await SavedJob.findOne({ owner: req.user._id, job: req.body?.jobId });
      if (existing) return res.status(200).json(existing);
    }
    next(error);
  }
}

/** DELETE /api/saved-jobs/:jobId — requires auth. */
export async function unsaveJob(req, res, next) {
  try {
    const { jobId } = req.params;
    if (!mongoose.isValidObjectId(jobId)) {
      throw badRequest("A valid jobId is required.", "INVALID_JOB_ID");
    }

    const savedJob = await SavedJob.findOneAndDelete({ owner: req.user._id, job: jobId });
    if (!savedJob) throw notFoundError("Saved job not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
