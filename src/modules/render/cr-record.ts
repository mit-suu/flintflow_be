/**
 * FLF-411 (U2-6) / FLF-466: mô tả dòng §I Record of Changes của change request theo **ngôn ngữ tài liệu**, dựng tất định từ các thay đổi đã ghi
 * ("Update system name; Add use case "Checkout""). Không gọi model, không in mã nội bộ của phần tử (A04, S03) — chỉ tên, hoặc mã tài liệu (UC-01, BR-03).
 */

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
  // Op đặt lên chính phần tử (`actors[]`, `actors[id=A04]`) ⇒ thêm / xoá phần tử; op vào bên trong phần tử ⇒ cập nhật
  const onElement = whole === (change.path ?? "")
  const verb: keyof typeof VERB = onElement && change.op === "add" ? "add" : onElement && change.op === "remove" ? "remove" : "update"
  const name = id ? nameOf(spine, entity, id) : null
  const target = name ? `${label} "${name}"` : id && DOCUMENT_ID_ENTITIES.has(entity) ? `${label} ${id}` : label
  return { verb, target }
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

/**
 * Mô tả một dòng §I của các CR liền nhau cùng loại A / M / D (BF §3.2, FLF-466): `CR-012, CR-013: <thay đổi gì>` — đủ mã các CR trong dòng, phần mô
 * tả dựng tất định từ chính các thay đổi (tối đa `MAX_ITEMS` mục rồi "và N mục khác"), theo ngôn ngữ tài liệu; **không** chép tiêu đề CR / câu chat / nguồn CR.
 * Không dựng được (không path nào đọc được) ⇒ `CR-012: Document updated` theo ngôn ngữ tài liệu.
 */
export const crRowDescription = (crIds: readonly string[], changes: readonly CrRecordChange[], language?: string, spine?: Spine): string =>
  `${[...new Set(crIds)].join(", ")}: ${describeCrChanges(changes, language, spine) ?? recordTextFor(language).documentUpdated}`
