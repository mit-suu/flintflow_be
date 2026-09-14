/**
 * context-projection.ts
 * ─────────────────────────────────────────────────────────────────
 * Context của MỘT step = projection Spine, không phải toàn Spine (Phases §3): chỉ field step đọc/ghi,
 * `addendum[]` nhắm section step nuôi, tài liệu upload theo budget, và câu trả lời Elicit của chính step.
 * Nạp toàn Spine/transcript làm chi phí input bậc hai theo số step (srs-spine §10).
 *
 * Bảng `STEP_SPECS` là BẢN TẠM trước step registry T12 (`reads/writes`), dựng từ Phases §6.1, §6.4 và
 * frontmatter skill content. Khi T12 merge: thay bằng `getStep(id)`.
 *
 * Selector projection:
 *   `actors`                         cả mảng/field
 *   `project.release_scope`          field lồng
 *   `actors[kind!=human]`            lọc (`=`, `!=`; giá trị `null`, `@loop`, `@loopFeature`)
 *   `functions:id,name,screen_id`    chỉ lấy vài field của mỗi phần tử
 */

import type { Addendum, Spine } from "../spine/spine.types.js"
import * as repository from "../spine/spine.repository.js"
import { listSections, stepsOf } from "../spine/section-registry.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { ChatSession } from "../project/chat-session.model.js"

export const STEP_NOT_FOUND = "STEP_NOT_FOUND"

export interface StepSpec {
  label_en: string
  /** Skill content của step (`assets/skills/content/*`); null ⇒ step tất định/render/gate, không Draft. */
  skill: string | null
  reads: readonly string[]
  /** Path gốc step được ghi (luôn kèm `assumptions`). Mức phase — T12 thu hẹp theo step. */
  writes: readonly string[]
}

const spec = (label_en: string, skill: string | null, reads: string[], writes: string[]): StepSpec =>
  Object.freeze({ label_en, skill, reads: Object.freeze(reads), writes: Object.freeze([...writes, "assumptions"]) })

const BRIEF_READS = ["project", "other_requirements", "assumptions[status=unconfirmed]"]
const BRIEF_WRITES = ["project", "addendum", "other_requirements"]
const ACTORS_READS = ["actors", "roles", "use_cases", "functions:id,name,screen_id"]
const LOOP_READS = [
  "screens[id=@loop]",
  "features[id=@loopFeature]",
  "functions[screen_id=@loop]",
  "roles:id,name,actor_id",
  "permissions[screen_id=@loop]",
  "business_rules[tier=detail]",
  "messages:id,code,text"
]
const NFR_READS = ["project:name,type,domain,complexity,stakes,form_factor", "nfrs", "actors[kind!=human]:id,name,kind"]

/** Bảng tạm step → reads/writes/skill (khoá = id step không có `@`). */
export const STEP_SPECS: Readonly<Record<string, StepSpec>> = Object.freeze({
  "B-0.1": spec("Brain Dump", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-0.2": spec("Form-Factor", "product-brief", ["project"], ["project"]),
  "B-0.3": spec("Stakes", "product-brief", ["project"], ["project"]),
  "B-0.4": spec("Working Mode", "product-brief", ["project"], ["project"]),
  "B-1.1": spec("Product Vision, Problem & Opportunity", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-1.2": spec("Target Users & Jobs-to-be-Done", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-1.3": spec("Value Proposition & Differentiation", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-1.4": spec("MVP Scope & Feature Hypotheses", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-1.5": spec("Success Metrics & Learning Goals", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-1.6": spec("Risks, Assumptions & Open Questions", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "B-2.1": spec("Assumption Sweep", "product-brief", ["assumptions"], []),
  "B-2.2": spec("Addendum Triage", "product-brief", ["project"], ["addendum"]),
  "B-2.3": spec("Three-Lens Review", "product-brief", BRIEF_READS, BRIEF_WRITES),
  "S-1.1": spec("Brief Extraction", "project-classifier", BRIEF_READS, ["project", "other_requirements"]),
  "S-1.2": spec("Project Classification", "project-classifier", ["project"], ["project"]),
  "S-1.3": spec("Conflict & Assumption Review", "project-classifier", BRIEF_READS, ["project", "other_requirements"]),
  "S-1.4": spec("Gap List", "project-classifier", BRIEF_READS, ["other_requirements"]),
  "S-2.1": spec("Product Overview", "product-overview", ["project", "actors[kind!=human]:id,name,kind"], ["project"]),
  "S-2.2": spec("Release 1.0 Scope", "product-overview", ["project"], ["project"]),
  "S-2.3": spec("External Systems", "product-overview", ["project:name,vision", "actors"], ["actors"]),
  "S-2.4": spec("High-Level Business Rules", "high-level-rules", ["project:name,vision,goals", "business_rules[tier=high]"], ["business_rules"]),
  "S-2.5": spec("System Context Diagram", null, ["project:name", "actors[kind!=human]"], []),
  "S-3.1": spec("Actors", "actors-and-usecases", ACTORS_READS, ["actors", "roles", "use_cases"]),
  "S-3.2": spec("Actor-Goal List", "actors-and-usecases", ACTORS_READS, ["actors", "roles", "use_cases"]),
  "S-3.3": spec("Missing Use Case Sweep", "actors-and-usecases", ACTORS_READS, ["actors", "roles", "use_cases"]),
  "S-3.4": spec("Use Case Relationships", "actors-and-usecases", ACTORS_READS, ["use_cases"]),
  "S-3.5": spec("Use Case Descriptions", "actors-and-usecases", ACTORS_READS, ["actors", "roles", "use_cases"]),
  "S-3.6": spec("Use Case Diagram", null, ["actors", "use_cases"], []),
  "S-4.1": spec(
    "Screen Inventory",
    "screens-and-flow",
    ["features", "screens", "functions:id,name,screen_id,feature_id,order", "use_cases:id,name,actor_ids", "progress"],
    ["features", "screens", "functions", "permissions", "use_cases", "sections", "progress"]
  ),
  "S-4.2": spec("Screens Flow", "screens-and-flow", ["features", "screens"], ["screens"]),
  "S-4.3": spec("Screen Authorization", "authorization-matrix", ["roles", "actors:id,name,kind", "screens:id,name,feature_id", "permissions"], ["roles", "permissions"]),
  "S-4.4": spec("Non-Screen Functions", "non-screen-functions", ["features", "functions[screen_id=null]", "use_cases:id,name,function_ids"], ["functions", "use_cases"]),
  "S-4.5": spec("Entity Relationship Diagram", "entities-erd", ["entities", "features:id,name"], ["entities"]),
  "S-5.1": spec("Screen Queue", "function-detail", ["progress", "screens:id,name,feature_id,detail_status,queue_order"], ["screens", "progress"]),
  "S-5.2": spec("Trigger & Description", "function-detail", LOOP_READS, ["functions", "screens"]),
  "S-5.3": spec("Screen Layout", null, ["screens[id=@loop]", "functions[screen_id=@loop]:id,name,description"], []),
  "S-5.4": spec("Function Details", "function-detail", LOOP_READS, ["functions", "screens"]),
  "S-5.5": spec("Screen Sign-off", null, ["screens[id=@loop]"], ["screens"]),
  "S-6.1": spec("External Interfaces", "nfr-quality-attributes", NFR_READS, ["nfrs"]),
  "S-6.2": spec("Usability", "nfr-quality-attributes", NFR_READS, ["nfrs"]),
  "S-6.3": spec("Reliability", "nfr-quality-attributes", NFR_READS, ["nfrs"]),
  "S-6.4": spec("Performance", "nfr-quality-attributes", NFR_READS, ["nfrs"]),
  "S-6.5": spec("Domain-Specific Attributes", "nfr-quality-attributes", NFR_READS, ["nfrs"]),
  "S-7.1": spec("Business Rules", "appendix-content", ["business_rules", "functions:id,name,validations"], ["business_rules"]),
  "S-7.2": spec("Common Requirements", "appendix-content", ["common_requirements", "project:name,form_factor"], ["common_requirements"]),
  "S-7.3": spec("Application Messages", "appendix-content", ["messages", "functions:id,name,abnormal"], ["messages"]),
  "S-7.4": spec("Other Requirements", "appendix-content", ["other_requirements", "project:name,stakes"], ["other_requirements"]),
  "S-8.1": spec("Glossary", "glossary", ["glossary", "actors:id,name", "entities:id,name", "screens:id,name", "features:id,name"], ["glossary"]),
  "S-8.2": spec("Document Assembly", null, [], []),
  "S-8.3": spec("Record of Changes", null, [], []),
  "S-8.4": spec("Consistency Pass", null, [], []),
  "S-9.1": spec("Completeness & Assumption Sweep", null, ["assumptions", "glossary"], ["glossary"]),
  "S-9.2": spec("Quality Lens Run", null, [], []),
  "S-9.3": spec("Business Goal Validation", null, ["project:name,vision,goals"], []),
  "S-9.4": spec("Requirement Prioritization", null, ["functions:id,name,feature_id,priority", "nfrs:id,category,statement,priority"], ["functions", "nfrs"]),
  "S-9.5": spec("Baseline Sign-off", null, [], [])
})

export interface ParsedStepId {
  id: string
  base: string
  phase: string
  /** `S01` hoặc `nonscreen` với vòng S-5; null ngoài vòng. */
  loop: string | null
}

export const parseStepId = (stepId: string): ParsedStepId => {
  const [base, loop] = stepId.split("@")
  return { id: stepId, base, phase: base.split(".")[0], loop: loop ?? null }
}

export const getStepSpec = (stepId: string): StepSpec => {
  const found = STEP_SPECS[parseStepId(stepId).base]
  if (!found) throw new ApiError(404, `Không có step ${stepId}`, STEP_NOT_FOUND)
  return found
}

// ─── projection ──────────────────────────────────────────────────

interface Selector {
  raw: string
  path: string[]
  filter: { key: string; negate: boolean; value: string } | null
  fields: string[] | null
}

const SELECTOR_RE = /^([a-z_]+(?:\.[a-z_]+)*)(?:\[([a-z_]+)(!?=)([^\]]+)\])?(?::([a-z_,]+))?$/

const parseSelector = (raw: string): Selector => {
  const m = SELECTOR_RE.exec(raw)
  if (!m) throw new Error(`Selector projection không hợp lệ: "${raw}"`)
  return {
    raw,
    path: m[1].split("."),
    filter: m[2] ? { key: m[2], negate: m[3] === "!=", value: m[4] } : null,
    fields: m[5] ? m[5].split(",") : null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const pick = (value: unknown, fields: string[] | null): unknown => {
  if (!fields || !isRecord(value)) return value
  return Object.fromEntries(fields.filter((f) => f in value).map((f) => [f, value[f]]))
}

const resolveFilterValue = (spine: Spine, value: string, loop: string | null): string | null | undefined => {
  if (value === "null") return null
  if (value === "@loop") return loop === "nonscreen" ? null : loop
  if (value === "@loopFeature") return spine.screens.find((s) => s.id === loop)?.feature_id
  return value
}

const selectValue = (spine: Spine, selector: Selector, loop: string | null): unknown => {
  let node: unknown = spine
  for (const key of selector.path) node = isRecord(node) ? node[key] : undefined

  if (Array.isArray(node)) {
    let items = node
    if (selector.filter) {
      const { key, negate, value } = selector.filter
      const expected = resolveFilterValue(spine, value, loop)
      if (expected === undefined) return []
      items = items.filter((el) => isRecord(el) && (el[key] === expected) !== negate)
    }
    return items.map((el) => pick(el, selector.fields))
  }
  return pick(node, selector.fields)
}

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)

/** Field rỗng ở cấp một (vd `project.vision`) — để Elicit chỉ hỏi phần thiếu. */
const emptyPaths = (selector: Selector, value: unknown): string[] => {
  const base = selector.path.join(".")
  if (isEmpty(value)) return [selector.raw]
  if (isRecord(value)) return Object.entries(value).filter(([, v]) => isEmpty(v)).map(([k]) => `${base}.${k}`)
  return []
}

export interface AddendumForModel {
  id: string
  topic: string
  target_section: string
  content_en: string
}

/** Section step nuôi (nghịch đảo `stepsOf`) + feature của màn trong vòng S-5. */
export const sectionsFedBy = (spine: Spine, stepId: string): string[] => {
  const { base, loop } = parseStepId(stepId)
  const fed = listSections(spine)
    .map((s) => s.id)
    .filter((id) => stepsOf(id, spine).some((owner) => owner === stepId || owner === base))
  const feature = loop ? spine.screens.find((s) => s.id === loop)?.feature_id : undefined
  return feature ? [...new Set([...fed, `feature:${feature}`])] : fed
}

const addendumFor = (spine: Spine, stepId: string): Addendum[] => {
  const { phase } = parseStepId(stepId)
  // Brief và S-1 đọc toàn bộ addendum (Phases §6.1 "Input từ Brief")
  if (phase.startsWith("B-") || phase === "S-1") return spine.addendum
  const sections = new Set(sectionsFedBy(spine, stepId))
  return spine.addendum.filter((a) => sections.has(a.target_section))
}

export interface StepProjection {
  step_id: string
  label_en: string
  skill: string | null
  writable: readonly string[]
  spine_version: number
  working_mode: Spine["project"]["working_mode"]
  projection: Record<string, unknown>
  emptyFields: string[]
  addendum: AddendumForModel[]
}

/** Phần thuần của `buildStepContext` — không DB. */
export const projectStep = (spine: Spine, stepId: string): StepProjection => {
  const stepSpec = getStepSpec(stepId)
  const { loop } = parseStepId(stepId)
  const projection: Record<string, unknown> = {}
  const emptyFields: string[] = []

  for (const raw of stepSpec.reads) {
    const selector = parseSelector(raw)
    const value = selectValue(spine, selector, loop)
    projection[raw] = value
    emptyFields.push(...emptyPaths(selector, value))
  }

  return {
    step_id: stepId,
    label_en: stepSpec.label_en,
    skill: stepSpec.skill,
    writable: stepSpec.writes,
    spine_version: spine.spine_version,
    working_mode: spine.project.working_mode,
    projection,
    emptyFields,
    addendum: addendumFor(spine, stepId).map(({ id, topic, target_section, content_en }) => ({ id, topic, target_section, content_en }))
  }
}

// ─── có DB ───────────────────────────────────────────────────────

export interface StepContext extends StepProjection {
  documents: string
  documentTokens: number
  transcriptTail: string
  /** Ước lượng token input (ký tự / 4) — ghi vào usage cho T22 đo. */
  contextTokens: number
}

export interface BuildStepContextOptions {
  sessionId?: string | null
  modelName?: string
  maxOutputTokens?: number
}

/** Số tin nhắn tối đa của step đưa vào prompt. */
export const TRANSCRIPT_TAIL_MESSAGES = 20

const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Chỉ tin nhắn gắn đúng step hiện tại (không phải toàn transcript). */
const loadTranscriptTail = async (sessionId: string | null | undefined, stepId: string): Promise<string> => {
  if (!sessionId) return ""
  const session = await ChatSession.findById(sessionId, { messages: 1 }).lean()
  const messages = (session?.messages ?? []).filter((m) => m.step === stepId).slice(-TRANSCRIPT_TAIL_MESSAGES)
  return messages.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`).join("\n")
}

export const buildStepContext = async (projectId: string, stepId: string, options: BuildStepContextOptions = {}): Promise<StepContext> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)

  const { projectId: _projectId, ...spine } = record
  const projected = projectStep(spine, stepId)
  const transcriptTail = await loadTranscriptTail(options.sessionId, stepId)
  const base = JSON.stringify(projected.projection) + JSON.stringify(projected.addendum) + transcriptTail
  const docs = await buildDocumentContext(projectId, ActionType.DRAFT, stepId, estimateTokens(base), options.modelName, options.maxOutputTokens)

  return {
    ...projected,
    documents: docs.contextText,
    documentTokens: docs.tokenCount,
    transcriptTail,
    contextTokens: estimateTokens(base) + docs.tokenCount
  }
}
