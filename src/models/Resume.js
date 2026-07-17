import { Schema, model } from "mongoose";

/**
 * Resume — everything a user builds in Resume Builder. One document per
 * resume; a user can own many (see resumes.controller.js for the
 * per-user CRUD + ownership checks).
 *
 * Each list section (experience, education, skills, ...) carries its own
 * `order` field rather than relying on array index, so reordering is a
 * matter of updating `order` values, not shuffling array positions —
 * this plays nicer with partial/optimistic updates from the editor than
 * needing to always resend the whole array.
 *
 * Kept as ONE document (not split across collections per section) on
 * purpose: a resume is always read and written as a whole (open the
 * editor, autosave the whole form) — there's no access pattern here that
 * benefits from separate collections, and one document per resume keeps
 * every CRUD op a single, fast, whole-document read/write, matching this
 * project's stated "don't introduce unnecessary DB queries" performance
 * requirement.
 */

const TEMPLATE_VALUES = ["modern", "professional", "minimal", "executive"];

const dateRangeFields = {
  startDate: { type: String, trim: true }, // "YYYY-MM" or "YYYY-MM-DD" — validated in resumes.controller.js
  endDate: { type: String, trim: true },
  current: { type: Boolean, default: false },
};

const experienceSchema = new Schema(
  {
    company: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    ...dateRangeFields,
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const educationSchema = new Schema(
  {
    school: { type: String, trim: true, default: "" },
    degree: { type: String, trim: true, default: "" },
    field: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    ...dateRangeFields,
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const skillSchema = new Schema(
  {
    name: { type: String, trim: true, required: true },
    level: { type: String, trim: true, default: "" }, // e.g. "Beginner".."Expert" — free text, editor supplies a picklist
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const projectSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    technologies: { type: [String], default: [] },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const certificationSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    issuer: { type: String, trim: true, default: "" },
    date: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const languageSchema = new Schema(
  {
    name: { type: String, trim: true, required: true },
    proficiency: { type: String, trim: true, default: "" }, // e.g. "Native", "Fluent", "Conversational"
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const awardSchema = new Schema(
  {
    title: { type: String, trim: true, default: "" },
    issuer: { type: String, trim: true, default: "" },
    date: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const volunteerSchema = new Schema(
  {
    organization: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    ...dateRangeFields,
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const referenceSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    relationship: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const resumeSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, trim: true, default: "Untitled Resume" },
    template: { type: String, enum: TEMPLATE_VALUES, default: "modern" },
    isDefault: { type: Boolean, default: false },

    personalInfo: {
      fullName: { type: String, trim: true, default: "" },
      headline: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      location: { type: String, trim: true, default: "" },
      photoUrl: { type: String, trim: true, default: "" },
    },
    summary: { type: String, trim: true, default: "" },

    experience: { type: [experienceSchema], default: [] },
    education: { type: [educationSchema], default: [] },
    skills: { type: [skillSchema], default: [] },
    projects: { type: [projectSchema], default: [] },
    certifications: { type: [certificationSchema], default: [] },
    languages: { type: [languageSchema], default: [] },
    awards: { type: [awardSchema], default: [] },
    volunteerExperience: { type: [volunteerSchema], default: [] },
    interests: { type: [String], default: [] },
    references: { type: [referenceSchema], default: [] },

    socialLinks: {
      linkedin: { type: String, trim: true, default: "" },
      github: { type: String, trim: true, default: "" },
      portfolio: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },
    },

    // Top-level section ordering (which sections appear, and in what
    // order) — separate from each section's own item-level `order`
    // above. Editor can reorder whole sections without touching item data.
    sectionOrder: {
      type: [String],
      default: [
        "summary",
        "experience",
        "education",
        "skills",
        "projects",
        "certifications",
        "languages",
        "awards",
        "volunteerExperience",
        "interests",
        "references",
      ],
    },
  },
  { timestamps: true },
);

// A user's own resume list, sorted by recency — the only query pattern
// resumes.controller.js#listResumes needs.
resumeSchema.index({ owner: 1, updatedAt: -1 });

// Enforces "one default resume per user" at the DB level (partial index:
// only documents with isDefault: true are constrained), so a race
// between two near-simultaneous "set as default" requests can't leave a
// user with two defaults — the controller also unsets any previous
// default first (see setDefault), but this index is the actual
// guarantee, not just app-level discipline.
resumeSchema.index(
  { owner: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

export const RESUME_TEMPLATES = TEMPLATE_VALUES;
export default model("Resume", resumeSchema);
