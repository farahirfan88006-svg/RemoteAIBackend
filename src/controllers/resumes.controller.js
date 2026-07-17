import Resume from "../models/Resume.js";
import { validateResumePayload, pickWritableFields } from "../utils/resumeValidators.js";
import { generateResumePayload } from "../ai/resumeGenerator.js";
import { notFoundError } from "../utils/AppError.js";

/**
 * Every handler here scopes its query to `{ _id, owner: req.user._id }`
 * in one shot (rather than "load by id, then compare req.user.id")
 * — one DB round trip per operation instead of two, and a resume that
 * exists but belongs to someone else looks identical to one that
 * doesn't exist at all (404, not 403) so ownership can never be probed
 * for via response differences.
 */

/**
 * GET /api/resumes
 * Requires auth. Returns the current user's resumes, most recently
 * updated first (matches the `{ owner, updatedAt }` index on the model
 * — no extra index needed for this, the list view, the only read this
 * endpoint does).
 */
export async function listResumes(req, res, next) {
  try {
    const resumes = await Resume.find({ owner: req.user._id })
      .sort({ updatedAt: -1 })
      // List view doesn't need full section content — keeps the payload
      // (and the query) light for what's just a picker/dashboard view.
      .select("title template isDefault updatedAt createdAt personalInfo.fullName")
      .lean();
    res.json(resumes);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/resumes
 * Requires auth. Body: any writable resume field (see
 * resumeValidators.js), all optional — an empty body creates a blank
 * draft, consistent with "auto-save drafts" being a first-class state.
 */
export async function createResume(req, res, next) {
  try {
    const payload = pickWritableFields(req.body || {});
    validateResumePayload(payload);

    // A user's very first resume becomes their default automatically —
    // one query to check, avoided entirely for everyone after their first.
    const isFirstResume = !(await Resume.exists({ owner: req.user._id }));

    const resume = await Resume.create({
      ...payload,
      owner: req.user._id,
      isDefault: isFirstResume,
    });
    res.status(201).json(resume);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/resumes/generate
 * Requires auth. Body: minimal info (name, contact, education,
 * experience, skills, projects, certifications, languages — see
 * ai/resumeGenerator.js). Expands it into a full resume and saves it
 * through the EXACT same path as `createResume` above — this handler
 * differs only in what builds the payload (`generateResumePayload`
 * instead of `pickWritableFields` on a full manual payload); validation,
 * default-resume assignment, and storage are shared, not duplicated.
 */
export async function generateResume(req, res, next) {
  try {
    const payload = generateResumePayload(req.body || {});
    validateResumePayload(payload);

    const isFirstResume = !(await Resume.exists({ owner: req.user._id }));

    const resume = await Resume.create({
      ...payload,
      owner: req.user._id,
      isDefault: isFirstResume,
    });
    res.status(201).json(resume);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/resumes/:id
 * Requires auth.
 */
export async function getResume(req, res, next) {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, owner: req.user._id });
    if (!resume) throw notFoundError("Resume not found.");
    res.json(resume);
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/resumes/:id
 * Requires auth. Also the auto-save endpoint — the editor is expected to
 * call this on a debounce as the user types, so it stays a single
 * findOneAndUpdate (no separate read-then-write).
 */
export async function updateResume(req, res, next) {
  try {
    const payload = pickWritableFields(req.body || {});
    validateResumePayload(payload);

    const resume = await Resume.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { $set: payload },
      { new: true, runValidators: true },
    );
    if (!resume) throw notFoundError("Resume not found.");
    res.json(resume);
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/resumes/:id
 * Requires auth. If the deleted resume was the default and the user has
 * other resumes left, the most recently updated of the rest becomes the
 * new default — otherwise a user could delete their default and be left
 * with no default at all despite having resumes remaining.
 */
export async function deleteResume(req, res, next) {
  try {
    const resume = await Resume.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!resume) throw notFoundError("Resume not found.");

    if (resume.isDefault) {
      const nextDefault = await Resume.findOne({ owner: req.user._id }).sort({ updatedAt: -1 });
      if (nextDefault) {
        nextDefault.isDefault = true;
        await nextDefault.save();
      }
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/resumes/:id/duplicate
 * Requires auth. The copy is always non-default (a user explicitly
 * chooses their default; duplicating shouldn't silently change it).
 */
export async function duplicateResume(req, res, next) {
  try {
    const original = await Resume.findOne({ _id: req.params.id, owner: req.user._id }).lean();
    if (!original) throw notFoundError("Resume not found.");

    const { _id, createdAt, updatedAt, isDefault, ...rest } = original;
    const copy = await Resume.create({
      ...rest,
      title: `${original.title} (Copy)`,
      isDefault: false,
    });
    res.status(201).json(copy);
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/resumes/:id/set-default
 * Requires auth. Two writes (unset the old default, set the new one) —
 * not a single atomic transaction (this project's MongoDB isn't assumed
 * to be a replica set, which Mongoose transactions require), so there's
 * a narrow race window on truly concurrent requests; see "Known
 * limitations" in the final summary. The unique partial index on
 * `{ owner, isDefault: true }` (see models/Resume.js) still guarantees
 * two documents can never both end up `isDefault: true`, even if the
 * two writes below interleave badly — the second write would simply
 * fail with a duplicate-key error rather than corrupt the invariant.
 */
export async function setDefaultResume(req, res, next) {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, owner: req.user._id });
    if (!resume) throw notFoundError("Resume not found.");

    if (!resume.isDefault) {
      await Resume.updateMany(
        { owner: req.user._id, isDefault: true },
        { $set: { isDefault: false } },
      );
      resume.isDefault = true;
      await resume.save();
    }

    res.json(resume);
  } catch (error) {
    next(error);
  }
}
