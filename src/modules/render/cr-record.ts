/**
 * FLF-411 (U2-6): mô tả dòng §I Record of Changes của một change request theo **ngôn ngữ tài liệu**, dựng tất định từ các
 * thay đổi đã ghi: "CR-001: Update system name; Add use case "Checkout"". Không gọi model, không in mã nội bộ của phần tử
 * (A04, S03) — chỉ tên, hoặc mã tài liệu (UC-01, BR-03). FLF-484: không còn chép tiêu đề CR (câu chat của người dùng).
 */

import { createHash } from "node:crypto"
import type { CrRecordSummary } from "../change-request/change-request.model.js"
import { isVietnamese, recordTextFor } from "./labels.js"
import type { Spine } from "../spine/spine.types.js"

type Lang = "en" | "vi"

/** Nhãn loại phần tử theo ngôn ngữ tài liệu (chữ thường, đặt giữa câu). */
const ENTITY_TEXT: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  features: { en: "feature", vi: "tính năng" },
  actors: { en: "actor", vi: "tác nhân" },
  roles: { en: "role", vi: "vai trò" },
  use_cases: { en: "use case", vi: "use case" },
  screens: { en: "screen", vi: "màn hình" },
  permissions: { en: "screen authorization", vi: "phân quyền màn hình" },
  entities: { en: "data entity", vi: "thực thể dữ liệu" },
  functions: { en: "function", vi: "chức năng" },
  validations: { en: "validation rule", vi: "quy tắc kiểm tra dữ liệu" },
  nfrs: { en: "non-functional requirement", vi: "yêu cầu phi chức năng" },
  business_rules: { en: "business rule", vi: "quy tắc nghiệp vụ" },
  common_requirements: { en: "common requirement", vi: "yêu cầu chung" },
  messages: { en: "message", vi: "thông báo" },
  other_requirements: { en: "other requirement", vi: "yêu cầu khác" },
  glossary: { en: "glossary term", vi: "thuật ngữ" },
  custom_sections: { en: "section", vi: "mục" },
  diagrams: { en: "diagram", vi: "sơ đồ" },
  assumptions: { en: "assumption", vi: "giả định" },
  references: { en: "reference", vi: "tài liệu tham khảo" }
}

/** Trường của thông tin dự án hay được sửa qua CR; trường khác ⇒ "project information". */
const PROJECT_FIELD_TEXT: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  system_name: { en: "system name", vi: "tên hệ thống" },
  name: { en: "project name", vi: "tên dự án" },
  vision: { en: "product vision", vi: "tầm nhìn sản phẩm" },
  goals: { en: "business goals", vi: "mục tiêu" },
  scope: { en: "scope", vi: "phạm vi" }
}
const PROJECT_TEXT: Readonly<Record<Lang, string>> = { en: "project information", vi: "thông tin dự án" }

const VERB: Readonly<Record<"add" | "remove" | "update", Readonly<Record<Lang, string>>>> = {
  add: { en: "Add", vi: "Thêm" },
  remove: { en: "Delete", vi: "Xoá" },
  update: { en: "Update", vi: "Cập nhật" }
}

/** Phần tử có mã in trong tài liệu (bảng UC, BR, MSG…) — thiếu tên thì gọi bằng mã; phần tử khác mã là nội bộ. */
const DOCUMENT_ID_ENTITIES: ReadonlySet<string> = new Set(["use_cases", "business_rules", "messages", "nfrs", "functions"])

/** Số thay đổi nêu trong một dòng; còn lại ghi "and N more changes". */
const MAX_ITEMS = 3

const TOP = /^([a-z_]+)(?:\[(?:id=)?([^\]]*)\])?(?:\.([a-z_]+))?/

export interface CrRecordChange {
  op: string
  path?: string
}

const nameOf = (spine: Spine | undefined, entity: string, id: string): string | null => {
  const list = (spine as unknown as Record<string, unknown> | undefined)?.[entity]
  if (!Array.isArray(list)) return null
  const el = list.find((x) => (x as { id?: unknown }).id === id) as Record<string, unknown> | undefined
  for (const key of ["name", "term", "title", "heading"]) {
    const v = el?.[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

/** Một thay đổi ⇒ (động từ, đối tượng) — `null` khi path không đọc được. */
const itemOf = (change: CrRecordChange, lang: Lang, spine: Spine | undefined): { verb: keyof typeof VERB; target: string } | null => {
  const m = TOP.exec(change.path ?? "")
  if (!m) return null
  const [whole, entity, id, field] = m
  if (entity === "project") return { verb: "update", target: (PROJECT_FIELD_TEXT[field ?? ""] ?? PROJECT_TEXT)[lang] }
  const label = ENTITY_TEXT[entity]?.[lang]
  if (!label) return null
  // Op đặt lên chính phần tử (`actors[]`, `actors[id=A04]`) ⇒ thêm / xoá phần tử; op vào bên trong phần tử (kể cả thêm vào
  // một field mảng như `use_cases[id=UC-01].function_ids`) ⇒ cập nhật
  const onElement = whole === (change.path ?? "") && !field
  const verb: keyof typeof VERB = onElement && change.op === "add" ? "add" : onElement && change.op === "remove" ? "remove" : "update"
  const name = id ? nameOf(spine, entity, id) : null
  const target = name ? `${label} "${name}"` : id && DOCUMENT_ID_ENTITIES.has(entity) ? `${label} ${id}` : label
  return { verb, target }
}

/** Các thay đổi không trùng của một dòng §I dưới dạng (động từ, đối tượng) theo ngôn ngữ tài liệu — đầu vào của lượt "AI viết gọn" (FLF-492). */
export const crChangeItems = (changes: readonly CrRecordChange[], language?: string, spine?: Spine): { verb: string; target: string }[] => {
  const lang: Lang = isVietnamese(language) ? "vi" : "en"
  const seen = new Set<string>()
  const items: { verb: string; target: string }[] = []
  for (const c of changes) {
    const item = itemOf(c, lang, spine)
    if (!item) continue
    const key = `${item.verb} ${item.target}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ verb: VERB[item.verb][lang], target: item.target })
  }
  return items
}

/** "Update system name; Add use case "Checkout"" — các thay đổi không trùng, tối đa `MAX_ITEMS`. */
export const describeCrChanges = (changes: readonly CrRecordChange[], language?: string, spine?: Spine): string | null => {
  const lang: Lang = isVietnamese(language) ? "vi" : "en"
  const seen = new Set<string>()
  const items: string[] = []
  for (const c of changes) {
    const item = itemOf(c, lang, spine)
    if (!item) continue
    const text = `${VERB[item.verb][lang]} ${item.target}`
    if (seen.has(text)) continue
    seen.add(text)
    items.push(text)
  }
  if (!items.length) return null
  const more = items.length - MAX_ITEMS
  return `${items.slice(0, MAX_ITEMS).join("; ")}${more > 0 ? recordTextFor(language).more(more) : ""}`
}

/** Loại thay đổi của một dòng §I (cột Change type): thêm / sửa / xoá. */
export type ChangeKind = "A" | "M" | "D"

/**
 * FLF-484 (lát D): loại của một thay đổi, cùng luật `onElement` của `itemOf` — op `add` đặt lên chính phần tử ⇒ A,
 * `remove` lên chính phần tử ⇒ D, còn lại (set / add vào mảng con / sửa field) ⇒ M.
 */
export const changeKindOf = (change: CrRecordChange): ChangeKind => {
  const path = change.path ?? ""
  const m = TOP.exec(path)
  const onElement = !!m && m[0] === path && !m[3]
  return onElement && change.op === "add" ? "A" : onElement && change.op === "remove" ? "D" : "M"
}

/** Dấu vân tay các thay đổi của một dòng §I (op + path, không phụ thuộc thứ tự) — gắn mô tả "AI viết gọn" với đúng dữ liệu nó viết. */
export const recordChangesHash = (changes: readonly CrRecordChange[]): string =>
  createHash("sha256")
    .update(changes.map((c) => `${c.op} ${c.path ?? ""}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 16)

/** Ngôn ngữ lưu cùng mô tả viết gọn. */
export const recordSummaryLanguage = (language?: string): CrRecordSummary["language"] => (isVietnamese(language) ? "vi" : "en")

/**
 * Mô tả dòng §I của một CR: `CR-001: <mô tả dựng từ thay đổi>` theo ngôn ngữ tài liệu (BF: dựng từ chính các thay đổi,
 * không chép câu chat hay tiêu đề CR). Không dựng được (không path nào đọc được) ⇒ `CR-001: Document updated`.
 */
export const crRecordDescription = (
  crId: string,
  changes: readonly CrRecordChange[],
  language?: string,
  spine?: Spine,
  summaries?: readonly CrRecordSummary[]
): string => {
  // FLF-492: mô tả AI viết gọn khi còn khớp loại, ngôn ngữ và đúng các thay đổi của dòng; không ⇒ câu dựng sẵn
  const hash = summaries?.length ? recordChangesHash(changes) : ""
  const kind = changes.length ? changeKindOf(changes[0]) : "M"
  const lang = recordSummaryLanguage(language)
  const concise = summaries?.find((s) => s.kind === kind && s.language === lang && s.changes_hash === hash)
  if (concise) return `${crId}: ${concise.text}`
  return `${crId}: ${describeCrChanges(changes, language, spine) ?? recordTextFor(language).documentUpdated}`
}
