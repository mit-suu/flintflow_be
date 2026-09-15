/**
 * context-projection.ts
 * ─────────────────────────────────────────────────────────────────
 * Context của MỘT step = projection Spine, không phải toàn Spine (Phases §3): chỉ field step đọc/ghi,
 * `addendum[]` nhắm section step nuôi, tài liệu upload theo budget, và câu trả lời Elicit của chính step.
 * Nạp toàn Spine/transcript làm chi phí input bậc hai theo số step (srs-spine §10).
 *
 * `reads`/`writes`/nhãn lấy từ step registry (T12, nguồn sự thật). Registry không mang skill content,
 * nên `STEP_SKILLS` giữ ánh xạ step → skill (frontmatter `assets/skills/content/*`).
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
import { DOCUMENTS_READ, getStep } from "./step-registry.js"

export { STEP_NOT_FOUND } from "./step-registry.js"

export interface StepSpec {
  label_en: string
  /** Skill content của step (`assets/skills/content/*`); null ⇒ step tất định/render/gate, không Draft. */
  skill: string | null
  /** Selector projection (đã bỏ token `documents`). */
  reads: readonly string[]
  /** Path gốc step được ghi (registry đã kèm `assumptions` với step Draft). */
  writes: readonly string[]
}

const skillFor = (skill: string, ids: string[]): [string, string][] => ids.map((id) => [id, skill])

/** Step → skill content (khoá = id step không có `@`). Step không có trong bảng không Draft bằng model. */
export const STEP_SKILLS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...skillFor("product-brief", ["B-0.1", "B-0.2", "B-0.3", "B-0.4", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6", "B-2.1", "B-2.2", "B-2.3"]),
    ...skillFor("project-classifier", ["S-1.1", "S-1.2", "S-1.3", "S-1.4"]),
    ...skillFor("product-overview", ["S-2.1", "S-2.2", "S-2.3"]),
    ...skillFor("high-level-rules", ["S-2.4"]),
    ...skillFor("actors-and-usecases", ["S-3.1", "S-3.2", "S-3.3", "S-3.4", "S-3.5"]),
    ...skillFor("screens-and-flow", ["S-4.1", "S-4.2"]),
    ...skillFor("authorization-matrix", ["S-4.3"]),
    ...skillFor("non-screen-functions", ["S-4.4"]),
    ...skillFor("entities-erd", ["S-4.5"]),
    ...skillFor("function-detail", ["S-5.1", "S-5.2", "S-5.4"]),
    ...skillFor("nfr-quality-attributes", ["S-6.1", "S-6.2", "S-6.3", "S-6.4", "S-6.5"]),
    ...skillFor("appendix-content", ["S-7.1", "S-7.2", "S-7.3", "S-7.4"]),
    ...skillFor("glossary", ["S-8.1"])
  ])
)

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

/** Ném 404 STEP_NOT_FOUND nếu step không có trong registry (kể cả `S-5.x` thiếu `@loop`). */
export const getStepSpec = (stepId: string): StepSpec => {
  const step = getStep(stepId)
  return {
    label_en: step.label_en,
    skill: STEP_SKILLS[step.template_id] ?? null,
    reads: step.reads.filter((read) => read !== DOCUMENTS_READ),
    writes: step.writes
  }
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

const ASSUMPTIONS_WRITE = "assumptions"
export const ASSUMPTION_KEYS_READ = "assumptions:id,path,status"

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

  // Step Draft nào cũng được ghi `assumptions[]` nhưng registry không khai `reads` cho nó: không thấy id đã có thì model
  // đặt trùng (`AS3` đã tồn tại — M3 2026-09-15). Chỉ đưa khoá tối thiểu, không tính vào emptyFields.
  if (stepSpec.writes.includes(ASSUMPTIONS_WRITE) && !stepSpec.reads.some((r) => r.startsWith(ASSUMPTIONS_WRITE))) {
    projection[ASSUMPTION_KEYS_READ] = selectValue(spine, parseSelector(ASSUMPTION_KEYS_READ), loop)
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
