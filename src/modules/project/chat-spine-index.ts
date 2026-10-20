/**
 * Chỉ mục Spine gọn cho CHAT: số phần tử mỗi collection + mã/tên của collection có tên. Trước đây CHAT chỉ thấy tài liệu
 * upload và đuôi transcript nên "có bao nhiêu use case?" bị đoán theo lịch sử chat. Đây KHÔNG phải nạp toàn Spine (điều
 * cấm 4): không có mô tả, luồng, quan hệ; mỗi danh sách có trần, cả khối có trần ký tự.
 */
import type { Spine } from "../spine/spine.types.js"

/** Số phần tử tối đa liệt kê tên cho mỗi collection; còn lại ghi "+N". */
export const SPINE_INDEX_MAX_ITEMS = 40
/** Trần ký tự cả khối (~1,5k token) — cắt ở cuối dòng. */
export const SPINE_INDEX_MAX_CHARS = 6000

type NamedKey = "features" | "actors" | "roles" | "use_cases" | "screens" | "entities" | "functions"
type CountedKey = "nfrs" | "business_rules" | "common_requirements" | "messages" | "other_requirements" | "glossary"

const NAMED: ReadonlyArray<[NamedKey, string]> = [
  ["features", "Features"],
  ["actors", "Actors"],
  ["roles", "Roles"],
  ["use_cases", "Use cases"],
  ["screens", "Screens"],
  ["entities", "Entities"],
  ["functions", "Functions"]
]

const COUNTED: ReadonlyArray<[CountedKey, string]> = [
  ["nfrs", "Non-functional requirements"],
  ["business_rules", "Business rules"],
  ["common_requirements", "Common requirements"],
  ["messages", "Messages"],
  ["other_requirements", "Other requirements (risks, assumptions, open questions)"],
  ["glossary", "Glossary terms"]
]

export type SpineIndexSource = Partial<Pick<Spine, NamedKey | CountedKey>>

const namedLine = (label: string, items: ReadonlyArray<{ id: string; name: string }>): string => {
  if (items.length === 0) return `- ${label}: 0`
  const shown = items.slice(0, SPINE_INDEX_MAX_ITEMS).map((item) => `${item.id} ${item.name}`.trim())
  const rest = items.length - shown.length
  return `- ${label}: ${items.length} — ${shown.join("; ")}${rest > 0 ? `; +${rest}` : ""}`
}

/** Rỗng khi chưa có Spine — prompt khi đó nói tài liệu chưa có dữ liệu. */
export const buildChatSpineIndex = (spine: SpineIndexSource | null | undefined): string => {
  if (!spine) return ""
  const lines = [
    ...NAMED.map(([key, label]) => namedLine(label, spine[key] ?? [])),
    ...COUNTED.map(([key, label]) => `- ${label}: ${(spine[key] ?? []).length}`)
  ]
  let text = ""
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line
    if (next.length > SPINE_INDEX_MAX_CHARS) return `${text}\n- …`
    text = next
  }
  return text
}
