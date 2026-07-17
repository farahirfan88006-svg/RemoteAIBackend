/**
 * Catches any request that didn't match a defined route and converts it
 * into the same error shape `errorHandler.js` produces for every other
 * error, so API consumers never see Express's default HTML 404 page.
 */
export function notFound(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  error.code = "NOT_FOUND";
  next(error);
}
