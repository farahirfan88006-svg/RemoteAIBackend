import { Schema, model } from "mongoose";

/**
 * Company — curated metadata for a company that also appears via
 * `companyName`/`companyLogo` on Job documents.
 *
 * Same relationship to Job as Category.js: `/api/companies` derives its
 * live list directly from Job documents (see companies.controller.js), so
 * this collection does not need to be populated for Phase 2 to work. It
 * exists so a later phase can attach curated data (verified website,
 * description, canonical logo) to a company name without changing the Job
 * schema — it is not read by anything in Phase 2 yet.
 */
const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    logo: { type: String, trim: true },
    website: { type: String, trim: true },
  },
  { timestamps: true },
);

export default model("Company", companySchema);
