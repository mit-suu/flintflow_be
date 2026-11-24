/**
 * FLF-473 (EduCampus B14): câu đếm số phần tử trong văn xuôi ("Hệ thống có 10 use case", "gồm 5 tác nhân") — khi một
 * change request làm đổi số phần tử của loại đó (thêm/xoá use case…), không ai cập nhật lại câu này và trước đây AI tự
 * suy số từ chính câu cũ (10 trừ 1 = 9) thay vì đếm trên Spine. Hàm thuần — không DB, không gọi model.
 *
 * Phạm vi bản đầu (plan fix #6 "Cần chốt" mục 3): chỉ nhận số viết bằng **chữ số** ("10 use case"), không nhận số viết
 * bằng chữ ("mười use case", "five actors") — tránh nhận nhầm số trong câu văn không liên quan tới đếm phần tử.
 */

import type { Spine } from "../spine/spine.types.js"

/** Loại phần tử có câu đếm nhận diện được — đúng các collection mà CR có thể thêm/xoá qua lô (dùng chung ở C-3/C-4/C-5). */
export const COUNT_COLLECTIONS = ["use_cases", "actors", "screens", "functions", "business_rules"] as const
export type CountCollection = (typeof COUNT_COLLECTIONS)[number]

export interface CountMention {
  /** Phần tử Spine chứa câu đếm — `custom_sections[id=…]` hoặc `project`. */
  path: string
  /** Chỉ số block trong `custom_sections[id=…].blocks` (phần tử `project` ⇒ 0, không có block thật). */
  block_index: number
  /** Số đã viết trong câu (trước khi sửa). */
  number: number
  collection: CountCollection
}

/** Danh từ (tiếng Việt + tiếng Anh) của mỗi loại phần tử — khớp theo ranh giới từ, không phân biệt hoa thường. */
const NOUN_PATTERN: Readonly<Record<CountCollection, string>> = {
  use_cases: "use cases?|ca sử dụng|UC",
  actors: "tác nhân|actors?",
  screens: "màn hình|screens?",
  functions: "chức năng|functions?",
  business_rules: "quy tắc(?:\\s+nghiệp vụ)?|business rules?"
}

const ALL_NOUNS = Object.values(NOUN_PATTERN).join("|")

/**
 * `(?<![\p{L}\p{N}-])` loại câu mã ("UC-10" không phải câu đếm vì có `-` ngay trước số); `(?!\s*%)` loại tỉ lệ ("10%").
 * Chỉ số viết bằng chữ số (xem ghi chú đầu file).
 */
const NUMBER_NOUN = new RegExp(`(?<![\\p{L}\\p{N}-])(\\d+)\\s*(${ALL_NOUNS})(?!\\s*%)(?![\\p{L}\\p{N}])`, "giu")

const collectionOfNoun = (noun: string): CountCollection | null => {
  for (const collection of COUNT_COLLECTIONS) {
    if (new RegExp(`^(?:${NOUN_PATTERN[collection]})$`, "iu").test(noun)) return collection
  }
  return null
}

/** Mọi câu đếm của một đoạn chữ, theo thứ tự xuất hiện. */
export const findCountMentionsInText = (text: string): { number: number; collection: CountCollection }[] => {
  const out: { number: number; collection: CountCollection }[] = []
  for (const m of text.matchAll(NUMBER_NOUN)) {
    const collection = collectionOfNoun(m[2])
    if (!collection) continue
    out.push({ number: Number(m[1]), collection })
  }
  return out
}

/** Chữ của `project` có thể mang câu đếm (tầm nhìn, phạm vi phát hành) — đủ cho test + ca thật thường gặp. */
const projectTexts = (project: Spine["project"]): string[] => [project.vision ?? "", ...(project.goals ?? [])].filter(Boolean)

/**
 * Mọi câu đếm trong Spine: văn xuôi của `custom_sections` (mục riêng — gồm cả phần nối tiêu đề rỗng) và `project`
 * (tầm nhìn/mục tiêu). Không quét các collection khác — chữ của chúng là dữ liệu có cấu trúc (tên, id…), không phải văn xuôi.
 */
export const findCountMentions = (spine: Pick<Spine, "custom_sections" | "project">): CountMention[] => {
  const out: CountMention[] = []
  for (const section of spine.custom_sections) {
    section.blocks.forEach((block, block_index) => {
      for (const hit of findCountMentionsInText(block.text)) out.push({ path: `custom_sections[id=${section.id}]`, block_index, ...hit })
    })
  }
  projectTexts(spine.project).forEach((text, i) => {
    for (const hit of findCountMentionsInText(text)) out.push({ path: "project", block_index: i, ...hit })
  })
  return out
}
