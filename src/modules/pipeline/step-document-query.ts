/**
 * Step cần đoạn nào của tài liệu upload (FLF-393) — hàm thuần.
 *
 * Step biết mình nuôi section nào (`sectionsFedBy`, nghịch đảo `stepsOf` của section registry) ⇒ tài liệu có cấu trúc
 * (SRS, đặc tả) được lấy theo **tiêu đề mục**, không qua tìm kiếm. Phần còn lại của ngân sách và tài liệu tự do (biên
 * bản họp, email) dùng BM25 với câu hỏi dựng từ nhãn step, tên các section / phần tử của vòng, và điều user vừa trả lời.
 *
 * Tên gọi khác của section (EN / VI, IEEE 830) lấy từ danh mục của import (`section-catalog.ts`) — section registry là
 * hợp đồng đóng băng, không khai thêm ở đó.
 */

import type { Spine } from "../spine/spine.types.js"
import { listSections } from "../spine/section-registry.js"
import { SECTION_CANDIDATES } from "../import/section-catalog.js"
import { getStep } from "./step-registry.js"

export interface StepDocumentQuery {
  /** Câu hỏi BM25. */
  query: string
  /** Tiêu đề (mọi tên gọi) của section step nuôi — để ghim chunk theo tiêu đề. */
  sectionTitles: string[]
}

/** Số ký tự câu trả lời gần nhất của user đưa vào câu hỏi. */
const ANSWER_CHARS = 600

const userAnswers = (transcriptTail: string): string =>
  transcriptTail
    .split("\n")
    .filter((line) => line.startsWith("User: "))
    .map((line) => line.slice("User: ".length))
    .join("\n")
    .slice(-ANSWER_CHARS)

/**
 * @param fedSectionIds  section step nuôi (`sectionsFedBy(spine, stepId)`)
 * @param transcriptTail đuôi transcript của step (`User: …` / `AI: …`)
 */
export const stepDocumentQuery = (spine: Spine, stepId: string, fedSectionIds: readonly string[], transcriptTail = ""): StepDocumentQuery => {
  const step = getStep(stepId)
  const titleById = new Map(listSections(spine).map((s) => [s.id, s.title_en]))

  const sectionTitles = [
    ...new Set(
      fedSectionIds.flatMap((id) => {
        const aliases = SECTION_CANDIDATES.find((c) => c.id === id)?.titles
        if (aliases) return aliases
        // `feature:<id>` / `function:<id>`: tiêu đề là tên phần tử; section không còn trong Spine ⇒ bỏ
        const title = titleById.get(id)
        return title ? [title] : []
      })
    )
  ]

  // Vòng S-5: tên màn đang soạn (function của màn đã nằm trong `fedSectionIds`)
  const loop = stepId.split("@")[1]
  const screenName = loop ? spine.screens.find((s) => s.id === loop)?.name : undefined

  const query = [step.label_en, ...sectionTitles, screenName ?? "", userAnswers(transcriptTail)].filter(Boolean).join("\n")
  return { query, sectionTitles }
}

/** Gộp câu hỏi của nhiều step (lượt phỏng vấn đầu giai đoạn hỏi thay cho cả đơn vị). */
export const mergeStepDocumentQueries = (queries: readonly StepDocumentQuery[]): StepDocumentQuery => ({
  query: [...new Set(queries.flatMap((q) => q.query.split("\n")))].join("\n"),
  sectionTitles: [...new Set(queries.flatMap((q) => q.sectionTitles))]
})
