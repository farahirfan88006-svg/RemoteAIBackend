/**
 * Shared pagination parsing, used by every list endpoint so "page 1,
 * 20 per page, clamp to something sane" is defined in exactly one place.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Parses `page`/`pageSize` off a raw query object. Invalid or missing
 * values fall back to sane defaults rather than erroring — every value a
 * user can put in a URL should produce *some* valid page of results.
 *
 * @param {object} query - raw req.query
 * @returns {{ page: number, pageSize: number }}
 */
export function parsePagination(query = {}) {
  const rawPage = Number.parseInt(query.page, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawPageSize = Number.parseInt(query.pageSize, 10);
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * @param {{ total: number, page: number, pageSize: number }} args
 * @returns {{ total: number, page: number, pageSize: number, totalPages: number }}
 */
export function buildPaginationMeta({ total, page, pageSize }) {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return { total, page, pageSize, totalPages };
}
