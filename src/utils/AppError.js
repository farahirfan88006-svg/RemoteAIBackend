/**
 * Small helper for the error shape errorHandler.js already expects
 * (statusCode + code on a plain Error). Existing controllers construct
 * this manually inline (see middleware/notFound.js); this just gives the
 * new auth/resume/analyzer code one place to do the same thing instead
 * of repeating `const error = new Error(...); error.statusCode = ...`
 * across a dozen new files.
 *
 * @param {string} message
 * @param {number} statusCode
 * @param {string} code
 * @returns {Error}
 */
export function AppError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export const badRequest = (message, code = "BAD_REQUEST") => AppError(message, 400, code);
export const unauthorized = (message = "Not authenticated", code = "UNAUTHORIZED") =>
  AppError(message, 401, code);
export const forbidden = (message = "Not allowed", code = "FORBIDDEN") => AppError(message, 403, code);
export const notFoundError = (message = "Not found", code = "NOT_FOUND") => AppError(message, 404, code);
export const conflict = (message, code = "CONFLICT") => AppError(message, 409, code);
