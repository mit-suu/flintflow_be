/**
 * Chữ đem embed của từng phần tử Spine (hàm thuần): bản tiếng Anh gọn — nhãn + mã + tên rồi các field có nghĩa
 * (mô tả, phát biểu, định nghĩa, luồng…). Bỏ field kỹ thuật (thứ tự, trạng thái, hash, bản `_vi`).
 * Đơn vị trùng đơn vị vị trí CR: `listElements` của `spine-location.ts`.
 */

import { createHash } from "node:crypto"
import type { Spine } from "../../spine/spine.types.js"
import type { IChangeRequest } from "../change-request.model.js"
import { listElements, PROJECT_PATH, sectionOfElement } from "../spine-location.js"

const LABELS: Readonly<Record<string, string>> = {
  project: "Project",
  actors: "Actor",
  roles: "Role",
  use_cases: "Use case",
  features: "Feature",
  screens: "Screen",
  permissions: "Permission",
  functions: "Function",
  entities: "Entity",
  nfrs: "Non-functional requirement",
  business_rules: "Business rule",
  common_requirements: "Common requirement",
  messages: "Message",
  other_requirements: "Other requirement",
  glossary: "Glossary term",
  assumptions: "Assumption",
  custom_sections: "Section"
}

/** Field đem embed, theo thứ tự in. Tên/tiêu đề đã nằm ở dòng đầu. */
const TITLE_FIELDS = ["name", "term", "heading"] as const
const BODY_FIELDS = [
  "system_name",
  "vision",
  "goals",
  "domain",
  "kind",
  "category",
  "tier",
  "code",
  "screen_id",
  "role_id",
  "action",
  "statement",
  "description",
  "definition",
  "term_native",
  "trigger",
  "normal",
  "abnormal",
  "validations",
  "text",
  "metric",
  "threshold",
  "rationale",
  "blocks"
] as const

/** Trần chữ mỗi phần tử — phần đầu (tên + mô tả) mang gần hết nghĩa, và giữ chi phí embed thấp. */
export const ELEMENT_TEXT_MAX_CHARS = 4000

type Row = Record<string, unknown>

/** Chữ của một giá trị: chuỗi giữ nguyên, mảng nối dòng, object con (validation, block) lấy `statement`/`text`/`name`. */
const flatten = (value: unknown): string => {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("; ")
  if (value && typeof value === "object") {
    const row = value as Row
    return flatten(row.statement ?? row.text ?? row.name ?? "")
  }
  return ""
}

export const arrayKeyOfElement = (path: string): string => (path === PROJECT_PATH ? PROJECT_PATH : (/^(\w+)\[/.exec(path)?.[1] ?? path))

/** Chữ của một phần tử: `Use case UC-01: Register account` + từng field `description: …`. */
export const renderElementText = (path: string, value: unknown): string => {
  const row = (value && typeof value === "object" ? value : {}) as Row
  const entity = arrayKeyOfElement(path)
  const id = path === PROJECT_PATH ? "" : String(row.id ?? "")
  const title = TITLE_FIELDS.map((f) => flatten(row[f])).find(Boolean) ?? ""
  const head = [LABELS[entity] ?? entity, id].filter(Boolean).join(" ") + (title ? `: ${title}` : "")
  const body = BODY_FIELDS.flatMap((f) => {
    const text = flatten(row[f])
    return text ? [`${f}: ${text}`] : []
  })
  return [head, ...body].join("\n").slice(0, ELEMENT_TEXT_MAX_CHARS)
}

export const textHash = (modelId: string, text: string): string => createHash("sha256").update(`${modelId}\n${text}`).digest("hex")

export interface ElementDoc {
  ref: string
  entity: string
  section_id: string
  text: string
  text_hash: string
}

/** Mọi phần tử làm được vị trí CR, kèm chữ + hash theo model đang dùng. */
export const elementDocs = (spine: Spine, modelId: string): ElementDoc[] =>
  listElements(spine).map((e) => {
    const text = renderElementText(e.path, e.value)
    return { ref: e.path, entity: arrayKeyOfElement(e.path), section_id: sectionOfElement(spine, e.path), text, text_hash: textHash(modelId, text) }
  })

export interface SyncPlan {
  /** Phần tử mới hoặc đổi chữ — phải embed. */
  embed: ElementDoc[]
  /** Dòng index của phần tử đã bị xoá khỏi Spine. */
  remove: string[]
  /** Phần tử không đổi — chỉ nâng `spine_version`. */
  keep: string[]
}

/** So index đang có với Spine hiện tại: chỉ embed phần tử đổi `text_hash`, xoá dòng của phần tử không còn. */
export const planSync = (current: readonly ElementDoc[], indexed: readonly { ref: string; text_hash: string }[]): SyncPlan => {
  const have = new Map(indexed.map((r) => [r.ref, r.text_hash]))
  const live = new Set(current.map((c) => c.ref))
  return {
    embed: current.filter((c) => have.get(c.ref) !== c.text_hash),
    remove: indexed.filter((r) => !live.has(r.ref)).map((r) => r.ref),
    keep: current.filter((c) => have.get(c.ref) === c.text_hash).map((c) => c.ref)
  }
}

/** Trần chữ query — đủ cho tiêu đề + mô tả + vài vòng làm rõ; model embed nhận ~2048 token. */
export const QUERY_TEXT_MAX_CHARS = 6000

/**
 * Chữ query C-3 đem tìm theo nghĩa: tiêu đề + mô tả + lệnh gộp thêm + hỏi/đáp các vòng làm rõ + từ khoá C-2.
 * Giữ nguyên ngôn ngữ người dùng viết (model embed đa ngữ — câu tiếng Việt vẫn gần phần tử tiếng Anh cùng nghĩa).
 */
export const crQueryText = (cr: Pick<IChangeRequest, "title" | "description" | "clarifications" | "amendments" | "targets">): string =>
  [
    cr.title,
    cr.description,
    ...(cr.amendments ?? []).map((a) => a.text),
    ...(cr.clarifications ?? []).flatMap((c) => c.questions.map((q, i) => (c.answers[i] ? `${q} ${c.answers[i]}` : "")).filter(Boolean)),
    cr.targets?.keywords?.length ? `Keywords: ${cr.targets.keywords.join(", ")}` : ""
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, QUERY_TEXT_MAX_CHARS)
