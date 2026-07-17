import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { env } from "../config/env.js";
import { SUPPORTED_MIME_TYPES } from "../ai/resumeParser.js";
import { analyzeResume, listAnalysisHistory, getAnalysisReport } from "../controllers/analyzer.controller.js";

/**
 * Mounted at /api/resume-analyzer in app.js. Requires auth throughout.
 *
 * Memory storage on purpose: the file only ever needs to exist long
 * enough to extract its text (see ai/resumeParser.js) — nothing here
 * writes the original upload to disk or any blob storage, so there's no
 * cleanup/retention policy to build for the raw file itself.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.resumeUploadMaxBytes },
  fileFilter: (req, file, cb) => {
    if (!SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
      const error = new Error("Only PDF and DOCX files are supported.");
      error.statusCode = 400;
      error.code = "UNSUPPORTED_FILE_TYPE";
      cb(error);
      return;
    }
    cb(null, true);
  },
});

/** Normalizes multer's own errors (e.g. file-too-large) into this API's { statusCode, code } error shape. */
function handleUploadErrors(err, req, res, next) {
  if (err && err.name === "MulterError") {
    err.statusCode = 400;
    err.code = err.code || "UPLOAD_ERROR";
    if (err.code === "LIMIT_FILE_SIZE") {
      err.message = `File is too large — max size is ${Math.round(env.resumeUploadMaxBytes / (1024 * 1024))}MB.`;
    }
  }
  next(err);
}

const router = Router();

router.use(requireAuth);

router.post("/analyze", upload.single("file"), handleUploadErrors, analyzeResume);
router.get("/history", listAnalysisHistory);
router.get("/history/:id", getAnalysisReport);

export default router;
