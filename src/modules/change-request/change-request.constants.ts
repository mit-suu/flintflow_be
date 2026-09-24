/** Hằng số change request mode 1 — không phụ thuộc mongoose (DTO, FE types dùng chung). FLF-171, plan §5.4. */

/** Nguồn của CR (UC-48): bắt buộc, để truy vết yêu cầu sửa đến từ đâu. */
/** `chat` (FLF-182): CR tự tạo từ lệnh sửa trong chat sau baseline v1 (mode 1 v2, D3). */
export const CR_SOURCE_KINDS = ["stakeholder_email", "meeting_minutes", "gap_report", "reupload", "viewer_comment", "verbal", "chat"] as const
export type CrSourceKind = (typeof CR_SOURCE_KINDS)[number]

/**
 * Nguồn nhận khi **tạo** CR mới — đúng 6 nguồn của BPMN 3.1 (email stakeholder, biên bản, gap, re-upload, comment
 * Viewer, yêu cầu miệng có tên). Mode 1 v3: không tạo CR nguồn `chat` nữa (lệnh trong chat là yêu cầu miệng);
 * `chat` chỉ còn trong `CR_SOURCE_KINDS` để đọc CR cũ.
 */
export const NEW_CR_SOURCE_KINDS = ["stakeholder_email", "meeting_minutes", "gap_report", "reupload", "viewer_comment", "verbal"] as const satisfies readonly CrSourceKind[]

/** Cách C-3 tìm ra vị trí (nút 3.4): đích + phần tử tham chiếu tới đích (Spine), phần tử nhắc mã/tên của đích, từ khoá. */
/** `preview` (mode 1 v3): phần tử bị op của bản xem trước đính kèm CR chạm tới. */
/**
 * `diagram` (§4.13): phần nối giữ **sơ đồ gốc** của người dùng mà CR chạm tới dữ liệu (hoặc nhắm mục) của nó. Đề xuất do
 * code tính, không qua AI: dữ liệu sau CR lệch hình ⇒ `edit` bỏ ảnh gốc (bản render in sơ đồ PlantUML), không ⇒ `not_related`.
 */
export const LOCATION_FOUND_BY = ["spine_link", "mention", "keyword", "preview", "diagram"] as const
export type LocationFoundBy = (typeof LOCATION_FOUND_BY)[number]

/** Kết luận của C-4 cho từng vị trí (nút 3.6, UC-81). Vị trí chưa kết luận chặn nộp (CR_LOCATION_UNCONCLUDED). */
export const LOCATION_CONCLUSIONS = ["edit", "comment", "not_related"] as const
export type LocationConclusion = (typeof LOCATION_CONCLUSIONS)[number]

export const GROUP_DECISIONS = ["pending", "approved", "rejected"] as const
export type GroupDecision = (typeof GROUP_DECISIONS)[number]

/** `CR-001`, `CR-002`… theo project (C-1, atomic counter). */
export const CR_ID_PATTERN = /^CR-\d{3,}$/
export const formatCrId = (seq: number): string => `CR-${String(seq).padStart(3, "0")}`

/**
 * Tài liệu bổ sung của CR (mode 1 v3 phase 7): người dùng dán chữ / upload file để AI có dữ kiện viết nội dung.
 * `text` = chữ gõ/dán, `file` = chữ tách từ .docx/.pdf/.txt/.md, `image` = chữ + mô tả Gemini đọc từ ảnh.
 */
export const CR_MATERIAL_KINDS = ["text", "file", "image"] as const
export type CrMaterialKind = (typeof CR_MATERIAL_KINDS)[number]
export const CR_MAX_MATERIALS = 10
/** Chữ giữ lại mỗi tài liệu; dài hơn ⇒ cắt, `truncated = true`. */
export const CR_MATERIAL_MAX_CHARS = 20_000
export const MATERIAL_ID_PATTERN = /^M\d{2,}$/
export const formatMaterialId = (seq: number): string => `M${String(seq).padStart(2, "0")}`
/** Chuẩn hoá chữ tài liệu bổ sung: bỏ khoảng trắng thừa, cắt ở `CR_MATERIAL_MAX_CHARS`. */
export const clipMaterialText = (raw: string): { text: string; truncated: boolean } => {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return text.length > CR_MATERIAL_MAX_CHARS ? { text: text.slice(0, CR_MATERIAL_MAX_CHARS), truncated: true } : { text, truncated: false }
}

export const LOCATION_ID_PATTERN = /^L\d{3,}$/
export const GROUP_ID_PATTERN = /^G\d{2,}$/
