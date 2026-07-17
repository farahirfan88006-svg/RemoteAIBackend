import { badRequest } from "../utils/AppError.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const SUPPORTED_MIME_TYPES = [PDF_MIME, DOCX_MIME];

/**
 * Extracts plain text from an uploaded resume file buffer.
 *
 * `pdf-parse` and `mammoth` are imported dynamically, inside each
 * branch, rather than statically at the top of the file: this module is
 * only ever reached after a real file upload, and lazy-loading means a
 * parser that's never needed for a given request is never even loaded
 * into memory (also avoids either package needing to be resolvable at
 * import time for code paths/tests that don't touch file parsing).
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
export async function extractResumeText(buffer, mimeType) {
  if (mimeType === PDF_MIME) {
    const { default: pdfParse } = await import("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  if (mimeType === DOCX_MIME) {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  throw badRequest("Only PDF and DOCX resumes are supported.", "UNSUPPORTED_FILE_TYPE");
}
