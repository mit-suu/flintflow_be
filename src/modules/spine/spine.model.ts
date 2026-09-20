/**
 * Mongoose model Spine — một document mỗi project.
 * Viết tay theo `spine.schema.ts`; mọi đổi field phải sửa cả hai nơi.
 *
 * Ghi vào collection này CHỈ qua `spine.repository.ts` (sau này là op engine T08).
 */

import mongoose, { Schema } from "mongoose"

const opts = { _id: false } as const
const nullableString = { type: String, default: null }
const nullableNumber = { type: Number, default: null }
const nullableDate = { type: Date, default: null }
const priority = { type: String, enum: ["must", "should", "could", "wont", null], default: null }

const releaseScopeSchema = new Schema(
  {
    in: { type: [String], default: [] },
    out: { type: [String], default: [] }
  },
  opts
)

const projectSchema = new Schema(
  {
    name: { type: String, default: "" },
    vision: nullableString,
    goals: { type: [String], default: [] },
    // `type` là tên field thật, không phải khai báo kiểu của Mongoose
    type: nullableString,
    domain: nullableString,
    complexity: nullableString,
    form_factor: nullableString,
    stakes: nullableString,
    working_mode: { type: String, enum: ["fast", "coaching", null], default: null },
    release_scope: { type: releaseScopeSchema, default: () => ({}) }
  },
  opts
)

const progressSchema = new Schema(
  {
    current_phase: nullableString,
    current_step: nullableString,
    screen_cursor: nullableString,
    screen_queue: { type: [String], default: [] },
    elicit_turns_this_phase: { type: Number, default: 0, min: 0 }
  },
  opts
)

const stepSchema = new Schema(
  {
    id: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "accepted", "revision_requested", "skipped"],
      required: true
    },
    first_seq: nullableNumber,
    last_seq: nullableNumber,
    accepted_at: nullableDate
  },
  opts
)

const featureSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    order: { type: Number, required: true, min: 0 }
  },
  opts
)

const actorSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    kind: { type: String, enum: ["human", "system", "time"], required: true },
    description: { type: String, default: "" }
  },
  opts
)

const roleSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    actor_id: nullableString
  },
  opts
)

const useCaseSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    actor_ids: { type: [String], default: [] },
    function_ids: { type: [String], default: [] },
    description: { type: String, default: "" },
    includes: { type: [String], default: [] },
    extends: { type: [String], default: [] }
  },
  opts
)

const screenSchema = new Schema(
  {
    id: { type: String, required: true },
    feature_id: { type: String, required: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    flow_to: { type: [String], default: [] },
    is_popup: { type: Boolean, default: false },
    tabs: { type: [String], default: [] },
    primary_function_id: nullableString,
    queue_order: nullableNumber,
    detail_status: {
      type: String,
      enum: ["pending", "in_progress", "signed_off", "placeholder"],
      default: "pending"
    }
  },
  opts
)

const permissionSchema = new Schema(
  {
    id: { type: String, required: true },
    screen_id: { type: String, required: true },
    role_id: { type: String, required: true },
    action: { type: String, required: true }
  },
  opts
)

const entitySchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    relations: { type: [String], default: [] }
  },
  opts
)

const validationSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ["business", "format", "required"], required: true },
    statement: { type: String, default: "" }
  },
  opts
)

const functionSchema = new Schema(
  {
    id: { type: String, required: true },
    screen_id: nullableString,
    feature_id: { type: String, required: true },
    order: { type: Number, required: true, min: 0 },
    name: { type: String, default: "" },
    trigger: { type: String, default: "" },
    description: { type: String, default: "" },
    normal: { type: [String], default: [] },
    abnormal: { type: [String], default: [] },
    validations: { type: [validationSchema], default: [] },
    business_rule_ids: { type: [String], default: [] },
    priority
  },
  opts
)

const nfrSchema = new Schema(
  {
    id: { type: String, required: true },
    category: {
      type: String,
      enum: ["interface", "usability", "reliability", "performance", "other"],
      required: true
    },
    statement: { type: String, default: "" },
    kind: { type: String, enum: ["quantitative", "descriptive"], required: true },
    metric: { type: String },
    threshold: { type: String },
    priority
  },
  opts
)

const businessRuleSchema = new Schema(
  {
    id: { type: String, required: true },
    tier: { type: String, enum: ["high", "detail"], required: true },
    statement: { type: String, default: "" },
    source_validation_ids: { type: [String], default: [] }
  },
  opts
)

const commonRequirementSchema = new Schema(
  {
    id: { type: String, required: true },
    category: { type: String, default: "" },
    statement: { type: String, default: "" }
  },
  opts
)

const messageSchema = new Schema(
  {
    id: { type: String, required: true },
    code: { type: String, default: "" },
    text: { type: String, default: "" },
    function_ids: { type: [String], default: [] }
  },
  opts
)

const otherRequirementSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: {
      type: String,
      enum: ["risk", "assumption", "open_question", "technical_risk"],
      required: true
    },
    statement: { type: String, default: "" }
  },
  opts
)

const glossaryTermSchema = new Schema(
  {
    id: { type: String, required: true },
    term: { type: String, default: "" },
    term_native: { type: String },
    definition: { type: String, default: "" }
  },
  opts
)

const addendumSchema = new Schema(
  {
    id: { type: String, required: true },
    topic: { type: String, default: "" },
    content: { type: String, default: "" },
    content_en: { type: String, default: "" },
    target_section: { type: String, required: true },
    captured_at: { type: Date, required: true }
  },
  opts
)

const customBlockSchema = new Schema(
  {
    kind: { type: String, enum: ["paragraph", "list_item", "table", "image"], required: true },
    text: { type: String, default: "" },
    rows: { type: [[String]], default: null },
    image_ref: { type: String, default: null }
  },
  opts
)

const customSectionSchema = new Schema(
  {
    id: { type: String, required: true },
    heading: { type: String, default: "" },
    level: { type: Number, required: true, min: 1, max: 9 },
    blocks: { type: [customBlockSchema], default: [] },
    source: { type: String, enum: ["import", "manual"], required: true }
  },
  opts
)

const diagramSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: {
      type: String,
      enum: ["context", "usecase", "screen_flow", "erd", "screen_layout"],
      required: true
    },
    puml: { type: String, default: "" },
    section: { type: String, required: true },
    owner_kind: nullableString,
    owner_id: nullableString,
    render_status: { type: String, enum: ["ok", "error"], required: true },
    error: { type: String },
    source_hash: { type: String, default: "" },
    rendered_at: nullableDate
  },
  opts
)

const assumptionSchema = new Schema(
  {
    id: { type: String, required: true },
    path: { type: String, required: true },
    statement: { type: String, default: "" },
    rationale: { type: String, default: "" },
    origin_step_id: { type: String, required: true },
    status: {
      type: String,
      enum: ["unconfirmed", "confirmed", "rejected"],
      default: "unconfirmed"
    },
    confirmed_at: nullableDate
  },
  opts
)

const flagSchema = new Schema(
  {
    id: { type: String, required: true },
    level: { type: String, enum: ["red", "yellow"], required: true },
    rule_id: { type: String, required: true },
    section_id: { type: String, required: true },
    target_id: nullableString,
    message: { type: String, default: "" },
    remediation_step: { type: String, required: true },
    opened_at_version: { type: Number, required: true, min: 1 },
    resolved_at: nullableDate,
    waived_by_user: { type: Boolean, default: false },
    waive_reason: { ...nullableString, minlength: 20 },
    waived_at_version: nullableNumber
  },
  opts
)

const sectionStateSchema = new Schema(
  {
    id: { type: String, required: true },
    asset_version: { type: String, default: "" }
  },
  opts
)

const baselineEntrySchema = new Schema(
  {
    id: { type: String, required: true },
    version: { type: String, required: true },
    type: { type: String, enum: ["generated", "imported", "release"], default: "generated" },
    doc_version: { type: String, default: null },
    at: { type: Date, required: true },
    snapshot_ref: { type: String, required: true },
    checked_at_version: { type: Number, required: true, min: 1 },
    waived_count: { type: Number, default: 0, min: 0 }
  },
  opts
)

const spineSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },

    project: { type: projectSchema, default: () => ({}) },
    progress: { type: progressSchema, default: () => ({}) },
    steps: { type: [stepSchema], default: [] },

    features: { type: [featureSchema], default: [] },
    actors: { type: [actorSchema], default: [] },
    roles: { type: [roleSchema], default: [] },
    use_cases: { type: [useCaseSchema], default: [] },
    screens: { type: [screenSchema], default: [] },
    permissions: { type: [permissionSchema], default: [] },
    entities: { type: [entitySchema], default: [] },
    functions: { type: [functionSchema], default: [] },
    nfrs: { type: [nfrSchema], default: [] },
    business_rules: { type: [businessRuleSchema], default: [] },
    common_requirements: { type: [commonRequirementSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
    other_requirements: { type: [otherRequirementSchema], default: [] },
    glossary: { type: [glossaryTermSchema], default: [] },
    addendum: { type: [addendumSchema], default: [] },
    custom_sections: { type: [customSectionSchema], default: [] },

    diagrams: { type: [diagramSchema], default: [] },
    assumptions: { type: [assumptionSchema], default: [] },
    flags: { type: [flagSchema], default: [] },
    sections: { type: [sectionStateSchema], default: [] },
    baselines: { type: [baselineEntrySchema], default: [] },

    spine_version: { type: Number, default: 1, min: 1 }
  },
  { timestamps: true, strict: true, minimize: false }
)

spineSchema.index({ projectId: 1 }, { unique: true })

export const Spine = mongoose.model("Spine", spineSchema)
