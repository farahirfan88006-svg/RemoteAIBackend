import { Schema, model } from "mongoose";

/**
 * Category — curated metadata for a category value that also appears as a
 * flat string on Job.category (e.g. "software-engineering").
 *
 * Phase 2's `/api/categories` endpoint does NOT require this collection to
 * be populated: it derives the live category list directly from whatever
 * categories currently exist on Job documents (see
 * services/jobQuery.service.js#getCategoryFacets), so categories are never
 * hardcoded and the endpoint works from an empty database. This model
 * exists so a later phase can attach curated data (a nicer display name,
 * an icon, a description) to a category slug without changing the Job
 * schema — it is not read by anything in Phase 2 yet.
 */
const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  },
  { timestamps: true },
);

export default model("Category", categorySchema);
