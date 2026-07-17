import { Schema, model } from "mongoose";

/**
 * One document per uploaded-resume analysis run — powers "Resume
 * history" (see the ticket). Stores the extracted text too (not just the
 * score) so a past report can be fully re-displayed without needing the
 * original file again — the original upload itself is never persisted
 * (see analyzer.controller.js: multer uses memory storage, nothing is
 * written to disk or a blob store), only what was derived from it.
 */
const resumeAnalysisSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fileName: { type: String, trim: true, default: "" },

    extractedText: { type: String, default: "" },
    atsScore: { type: Number, required: true, min: 0, max: 100 },

    sectionAnalysis: {
      present: { type: [String], default: [] },
      missing: { type: [String], default: [] },
    },
    detectedSkills: { type: [{ name: String, slug: String }], default: [] },
    missingSkills: { type: [{ name: String, slug: String }], default: [] },
    missingKeywords: { type: [String], default: [] },
    formattingIssues: { type: [String], default: [] },
    suggestions: { type: [String], default: [] },
  },
  { timestamps: true },
);

resumeAnalysisSchema.index({ owner: 1, createdAt: -1 });

export default model("ResumeAnalysis", resumeAnalysisSchema);
