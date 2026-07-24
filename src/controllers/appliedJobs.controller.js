import mongoose from "mongoose";
import AppliedJob, { APPLICATION_STATUS_VALUES } from "../models/AppliedJob.js";
import Job from "../models/Job.js";
import { badRequest, notFoundError } from "../utils/AppError.js";

/**
 * Applied Jobs — mark-as-applied + application status tracking.
 * Same owner-scoped-document pattern as savedJobs.controller.js
 * (and coverLetters.controller.js before it); see SavedJob's
 * buildJobSnapshot equivalent below for why a snapshot is stored
 * alongside the `job` ref.
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

/** GET /api/applied-jobs — requires auth. Most recently applied first. */
export async function listAppliedJobs(req, res, next) {
  try {
    const appliedJobs = await AppliedJob.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(appliedJobs);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/applied-jobs — requires auth.
 * Body: { jobId, status? } — status defaults to "applied" if omitted.
 * Idempotent: marking an already-applied job again just returns the
 * existing record unchanged (use PUT to change its status).
 */
export async function applyToJob(req, res, next) {
  try {
    const { jobId, status } = req.body || {};
    if (!jobId || !mongoose.isValidObjectId(jobId)) {
      throw badRequest("A valid jobId is required.", "MISSING_JOB_ID");
    }
    if (status !== undefined && !APPLICATION_STATUS_VALUES.includes(status)) {
      throw badRequest(
        `status must be one of: ${APPLICATION_STATUS_VALUES.join(", ")}.`,
        "INVALID_STATUS",
      );
    }

    const existing = await AppliedJob.findOne({ owner: req.user._id, job: jobId });
    if (existing) return res.status(200).json(existing);

    const job = await Job.findById(jobId).lean();
    if (!job) throw notFoundError("Job not found.");

    const appliedJob = await AppliedJob.create({
      owner: req.user._id,
      job: jobId,
      jobSnapshot: buildJobSnapshot(job),
      status: status || "applied",
    });
    res.status(201).json(appliedJob);
  } catch (error) {
    // DB-level unique index as a safety net against a race between the
    // findOne check above and this create (see model's compound index).
    if (error?.code === 11000) {
      const existing = await AppliedJob.findOne({ owner: req.user._id, job: req.body?.jobId });
      if (existing) return res.status(200).json(existing);
    }
    next(error);
  }
}

/** PUT /api/applied-jobs/:id — requires auth. Body: { status?, appliedDate? }. */
export async function updateApplication(req, res, next) {
  try {
    const { status, appliedDate } = req.body || {};
    const patch = {};

    if (status !== undefined) {
      if (!APPLICATION_STATUS_VALUES.includes(status)) {
        throw badRequest(
          `status must be one of: ${APPLICATION_STATUS_VALUES.join(", ")}.`,
          "INVALID_STATUS",
        );
      }
      patch.status = status;
    }

    if (appliedDate !== undefined) {
      const parsed = new Date(appliedDate);
      if (Number.isNaN(parsed.getTime())) {
        throw badRequest("appliedDate must be a valid date.", "INVALID_APPLIED_DATE");
      }
      patch.appliedDate = parsed;
    }

    if (Object.keys(patch).length === 0) {
      throw badRequest("Provide at least one of: status, appliedDate.", "EMPTY_UPDATE");
    }

    const appliedJob = await AppliedJob.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { $set: patch },
      { new: true, runValidators: true },
    );
    if (!appliedJob) throw notFoundError("Application not found.");
    res.json(appliedJob);
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/applied-jobs/:id — requires auth. */
export async function deleteApplication(req, res, next) {
  try {
    const appliedJob = await AppliedJob.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!appliedJob) throw notFoundError("Application not found.");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
