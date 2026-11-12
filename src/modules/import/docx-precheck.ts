/**
 * docx-precheck.ts — business-flow §3.6 "File trông như SRS" (D6): file .docx đặt ở ô Tài liệu tham khảo hoặc đính kèm trong chat
 * có trông như SRS không, có mang dấu version của dự án này không — để FE **gợi ý** (chuyển sang ô SRS / Cập nhật phiên bản mới /
 * Dùng làm tham khảo), không chặn gì. Dùng lại bộ nhận diện của I-1 (`preflightDocx` — dấu version + `document_kind`), không gọi
 * AI, không lưu file.
 */

import mongoose from "mongoose"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { DocBlock } from "./doc-block.model.js"
import { parseDocument } from "./parse.service.js"
import { preflightDocx, type PreflightResult } from "./preflight.service.js"

/** FLF-409: mức gợi ý cho file ở ô tham khảo - `strong` hỏi chuyển sang ô SRS, `possible` chỉ nhắc nhẹ, `none` im lặng. */
export type SrsSuggestion = "strong" | "possible" | "none"

export interface DocxPrecheck {
  /** `srs_suggestion === "strong"` - giữ cho luồng đính kèm chat. */
  looks_like_srs: boolean
  srs_suggestion: SrsSuggestion
  /** Dấu version FlintFlow trong file (file từng tải về từ một dự án); `null` ⇒ không có. */
  stamp: { project_id: string } | null
  /** 0–1: tỉ lệ heading của file trùng heading SRS của dự án — chỉ khi dự án đã có SRS (cảnh báo "giống bản cũ"). */
  heading_overlap?: number
}

const NOT_SRS: DocxPrecheck = { looks_like_srs: false, srs_suggestion: "none", stamp: null }

/** Điểm hình thức tối thiểu để `strong` (spec FLF-409 §3.2). */
export const STRONG_FORM_SCORE = 3

/**
 * Hàm thuần (FLF-409): `classifyDocument` cho `srs` chỉ từ nội dung yêu cầu (từ khoá, mã UC, bảng) nên bảng Use Case hay
 * danh sách FR cũng đạt. Gợi ý mạnh đòi thêm hình thức của một bộ SRS (chương lớn, heading nhiều cấp, lịch sử thay đổi,
 * mục lục) hoặc tiêu đề SRS; file mang dấu hiệu loại tài liệu khác (biên bản họp, test plan…) không được gợi ý.
 */
export const srsSuggestion = (result: Pick<PreflightResult, "stamp" | "document_kind">): SrsSuggestion => {
  if (result.stamp !== null) return "strong"
  const doc = result.document_kind
  if (!doc || (doc.kind !== "srs" && doc.kind !== "srs_template")) return "none"
  const has = (signal: string): boolean => doc.signals.includes(signal)
  const title = has("title:srs")
  if (!title && doc.signals.some((s) => s.startsWith("against:"))) return "none"
  if (title || doc.kind === "srs_template") return "strong"
  const chapters = doc.signals.filter((s) => s.startsWith("chapter:")).length
  const form = (chapters >= 3 ? 2 : chapters === 2 ? 1 : 0) + Number(has("form:levels")) + Number(has("form:revision")) + Number(has("form:toc"))
  return form >= STRONG_FORM_SCORE ? "strong" : "possible"
}

/** Gợi ý mạnh - giữ tên cũ cho chỗ gọi chỉ cần có / không. */
export const looksLikeSrs = (result: Pick<PreflightResult, "stamp" | "document_kind">): boolean => srsSuggestion(result) === "strong"

const normalizeHeading = (text: string): string =>
  text.trim().replace(/^[\dIVXivx]+(\.[\dIVXivx]+)*\.?\s+/, "").replace(/\s+/g, " ").toLowerCase()

/** Hàm thuần: tỉ lệ heading của file (bỏ số đánh mục, không phân biệt hoa thường) có trong SRS của dự án. */
export const headingOverlap = (fileHeadings: readonly string[], projectHeadings: readonly string[]): number => {
  const file = [...new Set(fileHeadings.map(normalizeHeading).filter(Boolean))]
  if (!file.length) return 0
  const project = new Set(projectHeadings.map(normalizeHeading).filter(Boolean))
  return Math.round((file.filter((h) => project.has(h)).length / file.length) * 100) / 100
}

const isDocx = (name: string): boolean => name.toLowerCase().endsWith(".docx")

/**
 * Kiểm một file. Không phải .docx ⇒ `looks_like_srs: false`. `projectId` (đính kèm trong dự án) ⇒ thêm `heading_overlap` khi dự
 * án đã có SRS tải lên. File hỏng / không đọc được ⇒ coi như không phải SRS (chỉ mất gợi ý).
 */
export const precheckDocx = async (buffer: Buffer, originalName: string, opts: { projectId?: string } = {}): Promise<DocxPrecheck> => {
  if (!isDocx(originalName)) return NOT_SRS
  const result = await preflightDocx(buffer)
  const suggestion = srsSuggestion(result)
  const looks = suggestion === "strong"
  const out: DocxPrecheck = { looks_like_srs: looks, srs_suggestion: suggestion, stamp: result.stamp ? { project_id: result.stamp.project_id } : null }
  if (!looks || !opts.projectId || !mongoose.isValidObjectId(opts.projectId)) return out
  const projectHeadings = await DocBlock.find({ projectId: opts.projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS }, kind: "heading" }, { text: 1 }).lean()
  if (!projectHeadings.length) return out
  try {
    const { blocks } = await parseDocument(buffer)
    out.heading_overlap = headingOverlap(blocks.filter((b) => b.kind === "heading").map((b) => b.text), projectHeadings.map((b) => b.text))
  } catch {
    // Không đọc được heading ⇒ không có cảnh báo "giống bản cũ"
  }
  return out
}
