import ResumeAnalysis from "../models/ResumeAnalysis.js";
import { extractResumeText } from "../ai/resumeParser.js";
import { analyzeResumeText } from "../ai/atsAnalyzer.js";
import { badRequest, notFoundError } from "../utils/AppError.js";

/**
 * POST /api/resume-analyzer/analyze
 * Requires auth. multipart/form-data, field name "file" (PDF or DOCX;
 * see routes/analyzer.routes.js for the multer config/size limit).
 */
export async function analyzeResume(req, res, next) {
  try {
    if (!req.file) throw badRequest("No file uploaded — attach a PDF or DOCX under the 'file' field.", "NO_FILE");

    const text = await extractResumeText(req.file.buffer, req.file.mimetype);
    if (!text.trim()) {
      throw badRequest("Couldn't extract any text from this file — it may be a scanned image rather than a text-based document.", "EMPTY_EXTRACTION");
    }

    const analysis = await analyzeResumeText(text);

    const report = await ResumeAnalysis.create({
      owner: req.user._id,
      fileName: req.file.originalname,
      extractedText: text,
      ...analysis,
    });

    res.status(201).json(report);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/resume-analyzer/history
 * Requires auth. List view omits `extractedText` (can be large) —
 * matches the same "light list, full detail on GET :id" pattern as
 * resumes.controller.js#listResumes.
 */
export async function listAnalysisHistory(req, res, next) {
  try {
    const reports = await ResumeAnalysis.find({ owner: req.user._id })
      .sort({ createdAt: -1 })
      .select("-extractedText")
      .lean();
    res.json(reports);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/resume-analyzer/history/:id
 * Requires auth.
 */
export async function getAnalysisReport(req, res, next) {
  try {
    const report = await ResumeAnalysis.findOne({ _id: req.params.id, owner: req.user._id });
    if (!report) throw notFoundError("Analysis report not found.");
    res.json(report);
  } catch (error) {
    next(error);
  }
}
