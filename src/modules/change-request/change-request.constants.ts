/** Hằng số change request mode 1 — không phụ thuộc mongoose (DTO, FE types dùng chung). FLF-171, plan §5.4. */

/** Nguồn của CR (UC-48): bắt buộc, để truy vết yêu cầu sửa đến từ đâu. */
export const CR_SOURCE_KINDS = ["stakeholder_email", "meeting_minutes", "gap_report", "reupload", "viewer_comment", "verbal"] as const
export type CrSourceKind = (typeof CR_SOURCE_KINDS)[number]

/** Cách C-3 tìm ra vị trí (nút 3.4): liên kết Spine ↔ block, mã thực thể nhắc trong text, từ khoá. */
export const LOCATION_FOUND_BY = ["spine_link", "mention", "keyword"] as const
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
