/**
 * Hằng số dùng chung của module import (model + DTO + FE types). Không phụ thuộc mongoose. FLF-171.
 */

/** Mã vấn đề preflight (I-1, nút 1.2). Nhận diện bằng magic bytes + nội dung, không bằng đuôi file (spike P0 §4.6). */
export const PREFLIGHT_ISSUE_CODES = [
  "NOT_DOCX",
  "CORRUPT_ZIP",
  "LEGACY_DOC",
  "FILE_ENCRYPTED",
  "FILE_TOO_LARGE",
  "EMPTY_DOCUMENT",
  "FOREIGN_TRACK_CHANGE",
  "FOREIGN_COMMENT"
] as const
export type PreflightIssueCode = (typeof PREFLIGHT_ISSUE_CODES)[number]

/** Giới hạn dung lượng file upload mode 1 (bằng multer hiện có của project-document). */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024

/** Author Track Changes/comment do FlintFlow ghi = mã CR (plan §1 nút 3.14). Tác giả khác ⇒ preflight từ chối. */
export const CR_AUTHOR_PATTERN = /^CR-\d{3,}$/

/** Custom property stamp — cùng tên với `render/docx-writer.ts` (mode 2) để đọc được file do mode 2 xuất. */
export const STAMP_PROPERTY = {
  project_id: "flintflow_project_id",
  version: "flintflow_version",
  source: "flintflow_source"
} as const

export const DOC_BLOCK_KINDS = [
  "heading",
  "paragraph",
  "list_item",
  "table",
  "table_row",
  "table_cell",
  "image",
  "caption",
  /** Textbox, SmartArt, field code, bảng lồng sâu… — giữ nguyên, không cho CR sửa (plan §10). */
  "unsupported"
] as const
export type DocBlockKind = (typeof DOC_BLOCK_KINDS)[number]

/** Tiền tố bookmark ẩn làm neo chính của block (G3 chốt sau P0): `_ff_B0001`. */
export const BLOCK_BOOKMARK_PREFIX = "_ff_"
export const BLOCK_ID_PATTERN = /^B\d{4,}$/

/** Thực thể có mã nhận diện được trong text (quét mention, I-2). */
export const MENTION_ENTITIES = ["use_case", "function", "nfr", "business_rule", "screen", "actor", "entity", "feature"] as const
export type MentionEntity = (typeof MENTION_ENTITIES)[number]

/** Ngưỡng độ tin (plan §6 2B/2C): mapping < 0.8 ⇒ 1.7; field < 0.7 ⇒ 1.9. */
export const MAPPING_CONFIDENCE_THRESHOLD = 0.8
export const FIELD_CONFIDENCE_THRESHOLD = 0.7

export const EXTRACTION_STATUSES = ["pending", "done", "failed"] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export const REUPLOAD_CHANGES = ["added", "removed", "modified", "moved"] as const
export type ReuploadChange = (typeof REUPLOAD_CHANGES)[number]

/** Cách nhận heading (I-3): styleId bị Word bản địa hoá nên đi qua tên style / outlineLvl; file không dùng style ⇒ mẫu số mục. */
export const HEADING_DETECTORS = ["style", "outline_level", "numbering_pattern", "user"] as const
export type HeadingDetector = (typeof HEADING_DETECTORS)[number]

/** Heading không khớp section nào của registry — giữ nguyên văn, không trích (I-3). */
export const UNMAPPED_SECTION = "unmapped"
