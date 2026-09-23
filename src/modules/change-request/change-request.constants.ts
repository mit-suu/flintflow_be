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
export const LOCATION_FOUND_BY = ["spine_link", "mention", "keyword", "preview"] as const
export type LocationFoundBy = (typeof LOCATION_FOUND_BY)[number]

/** Kết luận của C-4 cho từng vị trí (nút 3.6, UC-81). Vị trí chưa kết luận chặn nộp (CR_LOCATION_UNCONCLUDED). */
export const LOCATION_CONCLUSIONS = ["edit", "comment", "not_related"] as const
export type LocationConclusion = (typeof LOCATION_CONCLUSIONS)[number]

export const GROUP_DECISIONS = ["pending", "approved", "rejected"] as const
export type GroupDecision = (typeof GROUP_DECISIONS)[number]

/** `CR-001`, `CR-002`… theo project (C-1, atomic counter). */
export const CR_ID_PATTERN = /^CR-\d{3,}$/
export const formatCrId = (seq: number): string => `CR-${String(seq).padStart(3, "0")}`

export const LOCATION_ID_PATTERN = /^L\d{3,}$/
export const GROUP_ID_PATTERN = /^G\d{2,}$/
