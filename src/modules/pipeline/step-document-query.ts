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
  /** Step đọc rộng cả tài liệu (Brief, S-1) ⇒ kèm tóm tắt tài liệu nếu có. */
  broad: boolean
  /** Tin nhắn mới nhất của user (nếu có) — tìm đoạn riêng, ưu tiên trước câu hỏi chung (`DocumentContextRequest.focus`). */
  focus?: string
}

/**
 * Từ khoá EN / VI cho field mà step đọc (để hỏi / điền) — thêm vào câu hỏi BM25 để kéo về đoạn nói về chính field đó.
 * Thiếu bảng này thì step Brief chỉ tìm bằng nhãn ("Brain Dump"): demo 2026-11-12 trên SRS 3.870 đoạn, model không thấy
 * đoạn "responsive web-based interface…" (nền tảng) hay "NFR-35 … Privacy" (tuân thủ) và hỏi lại user điều tài liệu đã nói.
 * Khoá: `<gốc>` hoặc `project.<field>` của selector `reads`.
 */
export const FIELD_SEARCH_TERMS: Readonly<Record<string, string>> = {
  "project.name": "product name system name tên sản phẩm tên hệ thống",
  "project.system_name": "product name system name tên sản phẩm tên hệ thống",
  "project.vision": "product overview purpose vision problem opportunity tổng quan mục đích tầm nhìn vấn đề",
  "project.goals": "goals objectives business goals success metrics mục tiêu chỉ số thành công",
  "project.form_factor": "platform web browser responsive mobile app desktop device nền tảng trình duyệt di động ứng dụng thiết bị",
  "project.stakes": "compliance regulation legal privacy personal data security payment risk tuân thủ pháp lý quy định bảo mật dữ liệu cá nhân thanh toán rủi ro",
  "project.release_scope": "scope release version in scope out of scope phạm vi phiên bản",
  "project.type": "system type domain industry loại hệ thống lĩnh vực",
  "project.domain": "domain industry business lĩnh vực ngành nghiệp vụ",
  "project.complexity": "integration external system complexity tích hợp hệ thống ngoài",
  other_requirements: "constraint assumption dependency other requirements ràng buộc giả định phụ thuộc yêu cầu khác",
  actors: "actor user role stakeholder external system tác nhân người dùng vai trò bên liên quan",
  roles: "role permission authorization vai trò phân quyền",
  use_cases: "use case user goal ca sử dụng",
  business_rules: "business rule policy quy tắc nghiệp vụ",
  nfrs: "non-functional performance availability reliability usability security yêu cầu phi chức năng hiệu năng bảo mật",
  common_requirements: "common requirement general requirement yêu cầu chung",
  glossary: "glossary term definition abbreviation thuật ngữ định nghĩa"
}

/** Mục tổng quan được ghim cho step đọc rộng. */
const OVERVIEW_SECTION = "fixed:1"

const READ_SELECTOR = /^([a-z_]+)(?:\[[^\]]*\])?(?::([a-z_,]+))?$/

/** `project:name,vision` ⇒ `project.name`, `project.vision`; `actors[kind!=human]:id` ⇒ `actors`; `project` ⇒ mọi field project. */
export const readFieldKeys = (reads: readonly string[]): string[] =>
  reads.flatMap((raw) => {
    const m = READ_SELECTOR.exec(raw)
    if (!m) return []
    const root = m[1]!
    if (root !== "project") return [root]
    return m[2] ? m[2].split(",").map((f) => `project.${f}`) : Object.keys(FIELD_SEARCH_TERMS).filter((k) => k.startsWith("project."))
  })

/** Step đọc rộng: Brief và S-1 (đọc lại Brief) — thông tin chung của sản phẩm, không nuôi một mục cụ thể của tài liệu nguồn. */
const isBroadStep = (phase: string): boolean => phase.startsWith("B-") || phase === "S-1"

/** Số ký tự câu trả lời gần nhất của user đưa vào câu hỏi. */
const ANSWER_CHARS = 600

/** Dòng `User: …` cuối cùng của đuôi transcript. */
const lastUserMessage = (transcriptTail: string): string | undefined => {
  const lines = transcriptTail
    .split("\n")
    .filter((line) => line.startsWith("User: "))
    .map((line) => line.slice("User: ".length).trim())
    .filter(Boolean)
  return lines[lines.length - 1]
}

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

  const broad = isBroadStep(step.phase)
  if (broad) sectionTitles.push(...(SECTION_CANDIDATES.find((c) => c.id === OVERVIEW_SECTION)?.titles ?? []))
  const fieldTerms = [...new Set(readFieldKeys(step.reads).flatMap((k) => FIELD_SEARCH_TERMS[k] ?? []))]

  const query = [step.label_en, ...sectionTitles, screenName ?? "", ...fieldTerms, userAnswers(transcriptTail)].filter(Boolean).join("\n")
  const focus = lastUserMessage(transcriptTail)
  return { query, sectionTitles: [...new Set(sectionTitles)], broad, ...(focus ? { focus } : {}) }
}

/** Gộp câu hỏi của nhiều step (lượt phỏng vấn đầu giai đoạn hỏi thay cho cả đơn vị). */
export const mergeStepDocumentQueries = (queries: readonly StepDocumentQuery[]): StepDocumentQuery => ({
  query: [...new Set(queries.flatMap((q) => q.query.split("\n")))].join("\n"),
  sectionTitles: [...new Set(queries.flatMap((q) => q.sectionTitles))],
  broad: queries.some((q) => q.broad),
  ...(queries.find((q) => q.focus)?.focus ? { focus: queries.find((q) => q.focus)!.focus } : {})
})
