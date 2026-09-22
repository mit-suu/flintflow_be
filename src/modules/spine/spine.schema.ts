/**
 * spine.schema.ts
 * ─────────────────────────────────────────────────────────────────
 * Zod schema cho Spine — HỢP ĐỒNG ĐÓNG BĂNG sau M1 (coding-rules §0.2).
 * Nguồn: context/srs-spine.md §2. Kiểu TS tương ứng ở `spine.types.ts`.
 *
 * JSON Schema xuất ra `assets/schema/srs-spine.schema.json` bằng
 * `npm run schema:export`.
 *
 * Mọi object là strict: key lạ bị từ chối (ví dụ `sections[].status` — A7),
 * để output model sai hình không lọt vào Spine.
 */

import { z } from "zod"
import type * as T from "./spine.types.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
const nonNegativeInt = z.number().int().min(0)
const priority = z.enum(["must", "should", "could", "wont"])

// ─── project / progress / steps ──────────────────────────────────

export const releaseScopeSchema = z.strictObject({
  in: z.array(z.string()),
  out: z.array(z.string())
})

export const spineProjectSchema = z.strictObject({
  name: z.string(),
  /** FLF-177 — Spine trước đó không có ⇒ `null` (dùng tên project). */
  system_name: z.string().nullable().default(null),
  vision: z.string().nullable(),
  goals: z.array(z.string()),
  type: z.string().nullable(),
  domain: z.string().nullable(),
  complexity: z.string().nullable(),
  form_factor: z.string().nullable(),
  stakes: z.string().nullable(),
  working_mode: z.enum(["fast", "coaching"]).nullable(),
  release_scope: releaseScopeSchema
})

export const progressSchema = z.strictObject({
  current_phase: z.string().nullable(),
  current_step: z.string().nullable(),
  screen_cursor: z.string().nullable(),
  screen_queue: z.array(id),
  elicit_turns_this_phase: nonNegativeInt
})

export const stepStateSchema = z.strictObject({
  id,
  status: z.enum(["pending", "in_progress", "accepted", "revision_requested", "skipped"]),
  first_seq: z.number().int().min(1).nullable(),
  last_seq: z.number().int().min(1).nullable(),
  accepted_at: isoDateTime.nullable()
})

// ─── thực thể nghiệp vụ ──────────────────────────────────────────

export const featureSchema = z.strictObject({
  id,
  name: z.string(),
  order: nonNegativeInt
})

export const actorSchema = z.strictObject({
  id,
  name: z.string(),
  kind: z.enum(["human", "system", "time"]),
  description: z.string()
})

export const roleSchema = z.strictObject({
  id,
  name: z.string(),
  actor_id: id.nullable()
})

export const useCaseSchema = z.strictObject({
  id,
  name: z.string(),
  actor_ids: z.array(id),
  function_ids: z.array(id),
  description: z.string(),
  includes: z.array(id),
  extends: z.array(id)
})

export const screenSchema = z.strictObject({
  id,
  feature_id: id,
  name: z.string(),
  description: z.string(),
  flow_to: z.array(id),
  is_popup: z.boolean(),
  tabs: z.array(z.string()),
  primary_function_id: id.nullable(),
  queue_order: nonNegativeInt.nullable(),
  detail_status: z.enum(["pending", "in_progress", "signed_off", "placeholder"])
})

export const permissionSchema = z.strictObject({
  id,
  screen_id: id,
  role_id: id,
  action: z.string().min(1)
})

export const entitySchema = z.strictObject({
  id,
  name: z.string(),
  description: z.string(),
  relations: z.array(id)
})

export const validationSchema = z.strictObject({
  id,
  kind: z.enum(["business", "format", "required"]),
  statement: z.string()
})

export const functionSchema = z.strictObject({
  id,
  screen_id: id.nullable(),
  feature_id: id,
  order: nonNegativeInt,
  name: z.string(),
  trigger: z.string(),
  description: z.string(),
  normal: z.array(z.string()),
  abnormal: z.array(z.string()),
  validations: z.array(validationSchema),
  business_rule_ids: z.array(id),
  priority: priority.nullable()
})

export const nfrSchema = z.strictObject({
  id,
  category: z.enum(["interface", "usability", "reliability", "performance", "other"]),
  statement: z.string(),
  kind: z.enum(["quantitative", "descriptive"]),
  metric: z.string().optional(),
  threshold: z.string().optional(),
  priority: priority.nullable()
})

export const businessRuleSchema = z.strictObject({
  id,
  tier: z.enum(["high", "detail"]),
  statement: z.string(),
  source_validation_ids: z.array(id)
})

export const commonRequirementSchema = z.strictObject({
  id,
  category: z.string(),
  statement: z.string()
})

export const messageSchema = z.strictObject({
  id,
  code: z.string(),
  text: z.string(),
  function_ids: z.array(id)
})

export const otherRequirementSchema = z.strictObject({
  id,
  kind: z.enum(["risk", "assumption", "open_question", "technical_risk"]),
  statement: z.string()
})

export const glossaryTermSchema = z.strictObject({
  id,
  term: z.string(),
  term_native: z.string().optional(),
  definition: z.string()
})

export const addendumSchema = z.strictObject({
  id,
  topic: z.string(),
  content: z.string(),
  content_en: z.string(),
  target_section: z.string().min(1),
  captured_at: isoDateTime
})

export const customBlockSchema = z.strictObject({
  kind: z.enum(["paragraph", "list_item", "table", "image"]),
  text: z.string(),
  rows: z.array(z.array(z.string())).nullable(),
  image_ref: z.string().min(1).nullable()
})

export const customSectionSchema = z.strictObject({
  id,
  heading: z.string(),
  level: z.number().int().min(1).max(9),
  blocks: z.array(customBlockSchema),
  source: z.enum(["import", "manual"])
})

// ─── state nội bộ ────────────────────────────────────────────────

export const diagramSchema = z.strictObject({
  id,
  kind: z.enum(["context", "usecase", "screen_flow", "erd", "screen_layout"]),
  puml: z.string(),
  section: z.string().min(1),
  owner_kind: z.string().nullable(),
  owner_id: id.nullable(),
  render_status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  source_hash: z.string(),
  rendered_at: isoDateTime.nullable()
})

export const assumptionSchema = z.strictObject({
  id,
  path: z.string().min(1),
  statement: z.string(),
  rationale: z.string(),
  origin_step_id: id,
  status: z.enum(["unconfirmed", "confirmed", "rejected"]),
  confirmed_at: isoDateTime.nullable()
})

/** Tối thiểu cho lý do waive — srs-spine.md §7. */
export const WAIVE_REASON_MIN_LENGTH = 20

export const flagSchema = z.strictObject({
  id,
  level: z.enum(["red", "yellow"]),
  rule_id: z.string().min(1),
  section_id: z.string().min(1),
  target_id: id.nullable().optional(),
  message: z.string(),
  remediation_step: z.string().min(1),
  opened_at_version: z.number().int().min(1),
  resolved_at: isoDateTime.nullable(),
  waived_by_user: z.boolean(),
  waive_reason: z.string().min(WAIVE_REASON_MIN_LENGTH).nullable(),
  waived_at_version: z.number().int().min(1).nullable()
})

export const sectionStateSchema = z.strictObject({
  id: z.string().min(1),
  asset_version: z.string()
})

export const BASELINE_TYPES = ["generated", "imported", "release"] as const satisfies readonly T.BaselineType[]

/** Dữ liệu trước FLF-171 không có `type`/`doc_version` ⇒ đọc ra `generated` / `null`. */
const baselineTypeSchema = z.enum(BASELINE_TYPES).default("generated")
const docVersionSchema = z.string().min(1).nullable().default(null)

export const baselineSchema = z.strictObject({
  id,
  version: z.string().min(1),
  type: baselineTypeSchema,
  doc_version: docVersionSchema,
  at: isoDateTime,
  snapshot_ref: id,
  checked_at_version: z.number().int().min(1),
  waived_count: nonNegativeInt
})

// ─── Spine ───────────────────────────────────────────────────────

export const spineSchema = z.strictObject({
  project: spineProjectSchema,
  progress: progressSchema,
  steps: z.array(stepStateSchema),

  features: z.array(featureSchema),
  actors: z.array(actorSchema),
  roles: z.array(roleSchema),
  use_cases: z.array(useCaseSchema),
  screens: z.array(screenSchema),
  permissions: z.array(permissionSchema),
  entities: z.array(entitySchema),
  functions: z.array(functionSchema),
  nfrs: z.array(nfrSchema),
  business_rules: z.array(businessRuleSchema),
  common_requirements: z.array(commonRequirementSchema),
  messages: z.array(messageSchema),
  other_requirements: z.array(otherRequirementSchema),
  glossary: z.array(glossaryTermSchema),
  addendum: z.array(addendumSchema),
  /** FLF-182 — Spine trước mode 1 v2 không có ⇒ `[]`. */
  custom_sections: z.array(customSectionSchema).default([]),

  diagrams: z.array(diagramSchema),
  assumptions: z.array(assumptionSchema),
  flags: z.array(flagSchema),
  sections: z.array(sectionStateSchema),
  baselines: z.array(baselineSchema),

  spine_version: z.number().int().min(1)
})

export const spineRecordSchema = spineSchema.extend({
  projectId: id
})

// ─── collection tách riêng ───────────────────────────────────────

export const changeSchema = z.strictObject({
  projectId: id,
  seq: z.number().int().min(1),
  txn: id,
  op: z.string().min(1),
  path: z.string().min(1),
  before: z.unknown(),
  value: z.unknown(),
  reason: z.string().nullable(),
  at: isoDateTime,
  by: z.string().min(1),
  step_id: z.string().nullable()
})

export const usageSchema = z.strictObject({
  projectId: id,
  userId: id,
  step_id: id,
  call_kind: z.string().min(1),
  attempt: z.number().int().min(1),
  tokens_in: nonNegativeInt,
  tokens_out: nonNegativeInt,
  cost: z.number().min(0),
  state: z.enum(["reserved", "deducted", "refunded"]),
  expires_at: isoDateTime,
  logId: id.nullable()
})

export const baselineSnapshotSchema = z.strictObject({
  projectId: id,
  version: z.string().min(1),
  type: baselineTypeSchema,
  doc_version: docVersionSchema,
  at: isoDateTime,
  checked_at_version: z.number().int().min(1),
  waived_count: nonNegativeInt,
  snapshot: spineSchema
})

// ─── kiểm compile-time: zod ⇔ spine.types.ts ─────────────────────

type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false

// Nếu một dòng dưới báo lỗi: spine.types.ts và schema đã lệch nhau.
const typeChecks: [
  Equals<z.infer<typeof spineSchema>, T.Spine>,
  Equals<z.infer<typeof spineRecordSchema>, T.SpineRecord>,
  Equals<z.infer<typeof changeSchema>, T.Change>,
  Equals<z.infer<typeof usageSchema>, T.Usage>,
  Equals<z.infer<typeof baselineSnapshotSchema>, T.BaselineSnapshot>
] = [true, true, true, true, true]
void typeChecks

// ─── JSON Schema ─────────────────────────────────────────────────

export const SPINE_JSON_SCHEMA_ID = "urn:flintflow:schema:srs-spine"

/** JSON Schema (draft 2020-12) của Spine document, dùng cho fixture/skill. */
export const toJsonSchema = (): Record<string, unknown> => ({
  $id: SPINE_JSON_SCHEMA_ID,
  title: "FlintFlow SRS Spine",
  ...z.toJSONSchema(spineSchema, { target: "draft-2020-12" })
})

/** Nội dung file `assets/schema/srs-spine.schema.json` (test so khớp để bắt quên export). */
export const serializeJsonSchema = (): string => `${JSON.stringify(toJsonSchema(), null, 2)}\n`
