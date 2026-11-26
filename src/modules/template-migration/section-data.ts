/**
 * Phần tử Spine của một mục (theo `section_id`) — nguồn chung cho: tóm tắt nội dung mục "Không in ra" (dàn tiêu đề), cỡ dữ liệu + mẫu
 * nội dung để chấm chỗ đặt (`place-score`), và "mục thiếu theo cặp nhưng Spine có dữ liệu" (in từ Spine, không phải "Cần viết").
 * Thuần, không DB.
 */
import { NFR_CATEGORY_BY_SECTION, targetsOf } from "../import/extract-targets.js"
import { contentSlot, slotHasData } from "../import/content-slots.js"
import { LOCALIZATION_CATEGORIES, SECURITY_CATEGORIES, commonCategoryIn } from "../render/labels.js"
import type { Spine } from "../spine/spine.types.js"
import { isFreeTextSection, type OldSectionData } from "./classify.js"

/** Một phần tử của mục: mã (nếu có) + câu ngắn. */
export interface SectionItem {
  id: string | null
  text: string
}

export type SectionDataSpine = Pick<Spine, "custom_sections"> & Partial<Spine>

const TEXT_FIELDS = ["statement", "name", "description", "text", "term", "title", "content", "message"] as const
/** Số phần tử đầu dùng làm mẫu nội dung khi chấm nghĩa, và trần ký tự của mẫu. */
const SAMPLE_ITEMS = 20
const SAMPLE_CHARS = 2000

export const shortText = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > 140 ? `${one.slice(0, 137)}...` : one
}

const textOf = (item: Record<string, unknown>): string => {
  for (const f of TEXT_FIELDS) if (typeof item[f] === "string" && (item[f] as string).trim()) return item[f] as string
  return ""
}

const itemsOfArray = (value: unknown, keep: (item: Record<string, unknown>) => boolean = () => true): SectionItem[] => {
  if (!Array.isArray(value)) return []
  const out: SectionItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    if (!keep(item)) continue
    const text = textOf(item)
    if (text) out.push({ id: typeof item.id === "string" ? item.id : null, text: shortText(text) })
  }
  return out
}

const plain = (texts: readonly (string | null | undefined)[]): SectionItem[] => texts.filter((t): t is string => !!t?.trim()).map((t) => ({ id: null, text: shortText(t) }))

/** Phần dữ liệu nằm trong `project` / lọc theo loại — không suy được từ "collection đích" của mục. */
const slotItems = (sectionId: string, spine: SectionDataSpine): SectionItem[] | null => {
  const project = spine.project
  switch (sectionId) {
    case "slot:vision":
      return plain([project?.vision])
    case "slot:goals":
      return plain(project?.goals ?? [])
    case "slot:scope":
      return plain([...(project?.release_scope.in ?? []), ...(project?.release_scope.out ?? [])])
    case "fixed:1":
      return [
        ...plain([project?.vision, ...(project?.goals ?? [])]),
        ...itemsOfArray(spine.business_rules, (r) => r.tier === "high"),
        ...itemsOfArray(spine.actors, (a) => a.kind !== "human")
      ]
    case "slot:high_rules":
      return itemsOfArray(spine.business_rules, (r) => r.tier === "high")
    case "slot:context":
      return itemsOfArray(spine.actors, (a) => a.kind !== "human")
    case "slot:assumptions":
      return [...itemsOfArray(spine.assumptions, (a) => a.status !== "rejected"), ...itemsOfArray(spine.other_requirements, (o) => o.kind === "assumption")]
    case "slot:risks":
      return itemsOfArray(spine.other_requirements, (o) => o.kind === "risk" || o.kind === "technical_risk")
    case "slot:open_questions":
      return itemsOfArray(spine.other_requirements, (o) => o.kind === "open_question")
    case "slot:security":
      return itemsOfArray(spine.common_requirements, (c) => typeof c.category === "string" && commonCategoryIn(c.category, SECURITY_CATEGORIES))
    case "slot:localization":
      return itemsOfArray(spine.common_requirements, (c) => typeof c.category === "string" && commonCategoryIn(c.category, LOCALIZATION_CATEGORIES))
    default:
      return null
  }
}

/** Phần tử của mục: mục chữ tự do ⇒ đoạn văn; phần nhỏ của `project` ⇒ field tương ứng; mục khung ⇒ phần tử Spine (NFR lọc theo nhóm). */
export const sectionItemsOf = (sectionId: string, spine: SectionDataSpine): SectionItem[] => {
  if (isFreeTextSection(sectionId)) {
    const id = sectionId.startsWith("custom:") ? sectionId.slice("custom:".length) : null
    const section = id ? spine.custom_sections.find((c) => c.id === id) : undefined
    return (section?.blocks ?? []).filter((b) => b.text.trim()).map((b) => ({ id: null, text: shortText(b.text) }))
  }
  const special = slotItems(sectionId, spine)
  if (special) return special
  const category = NFR_CATEGORY_BY_SECTION[sectionId]
  const targets = contentSlot(sectionId)?.targets ?? targetsOf(sectionId)
  return targets.flatMap((t) => itemsOfArray((spine as unknown as Record<string, unknown>)[t], (item) => t !== "nfrs" || !category || item.category === category))
}

/** Tóm tắt để chấm chỗ đặt: số phần tử + mẫu nội dung (vài phần tử đầu, cắt ngắn) + phần tử có mã. */
export const sectionDataOf = (sectionId: string, spine: SectionDataSpine): OldSectionData => {
  const items = sectionItemsOf(sectionId, spine)
  return { size: items.length, sample: items.slice(0, SAMPLE_ITEMS).map((i) => i.text).join(" ").slice(0, SAMPLE_CHARS), items: items.filter((i) => i.id) }
}

/** Spine có dữ liệu để in dưới heading mang `section_id` này (dù heading không có cặp). */
export const spineFilled = (sectionId: string, spine: SectionDataSpine): boolean => {
  if (contentSlot(sectionId) && spine.project && slotHasData(spine as Spine, sectionId)) return true
  return sectionItemsOf(sectionId, spine).length > 0
}
