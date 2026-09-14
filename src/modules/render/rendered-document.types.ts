/**
 * Hợp đồng giữa Assemble (T15) và writer xuất file (T05). Đóng băng sau M1:
 * đổi phải qua PR `contract-change` và báo C (T15), D (T16).
 *
 * Nội dung render vào SRS là tiếng Anh; số hiệu section do Assemble sinh sẵn (Phases §6.3),
 * writer không tự đánh số.
 */

export type RenderSource = "draft" | "baseline"

/** Trạng thái hiển thị — hàm tính ở T09, không lưu DB. */
export type RenderedSectionStatus = "draft" | "accepted" | "stale" | "derived"

export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  /** Code inline (font đơn cách). */
  code?: boolean
}

/** Một ô bảng = một dãy run. */
export type TableCell = InlineRun[]

export interface ParagraphBlock {
  type: "paragraph"
  runs: InlineRun[]
}

export interface HeadingBlock {
  type: "heading"
  /** Cấp heading tuyệt đối 1–6 (không vào mục lục nếu > 3). */
  level: number
  text: string
}

export interface BulletListBlock {
  type: "bullet_list"
  items: InlineRun[][]
}

export interface NumberedListBlock {
  type: "numbered_list"
  items: InlineRun[][]
}

export interface TableBlock {
  type: "table"
  header: TableCell[]
  rows: TableCell[][]
}

export interface ImageBlock {
  type: "image"
  /** PNG: Buffer khi gọi trong process, chuỗi base64 (có thể kèm tiền tố `data:image/png;base64,`) khi qua HTTP. */
  png: Buffer | string
  caption?: string
}

export interface PageBreakBlock {
  type: "page_break"
}

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | BulletListBlock
  | NumberedListBlock
  | TableBlock
  | ImageBlock
  | PageBreakBlock

export interface RenderedSection {
  /** Khoá logic (`fixed:2.1`, `feature:F2`, `function:FN3`). */
  id: string
  /** Số hiệu hiển thị do Assemble sinh (`2.2.1`). */
  number: string
  heading: string
  /** Cấp heading 1–6. */
  level: number
  status?: RenderedSectionStatus
  awaiting_reaccept?: boolean
  blocks: Block[]
}

export type RocChangeType = "A" | "M" | "D"

/** Một dòng §I Record of Changes (khung FPT). */
export interface RocRow {
  /** `YYYY-MM-DD`. */
  date: string
  version: string
  change_type: RocChangeType
  in_charge: string
  description: string
}

export interface FlagRow {
  id: string
  rule_id: string
  /** Nhãn section đã phân giải để hiển thị (`3.2.1 Create Project`), không phải khoá logic. */
  section: string
  message: string
  waive_reason?: string | null
}

export interface FlagsAppendix {
  /** Cờ đỏ `resolved_at = null` và `waived_by_user = false`. */
  redOpen: FlagRow[]
  staleCount: number
  waived: FlagRow[]
}

export interface RenderedDocument {
  /** Ghi vào custom property `flintflow_project_id` (business-flow §6 — dấu version trong file). */
  projectId: string
  projectName: string
  /** `v0.7`, `v1.0`, `v1.0-conditional` … */
  version: string
  source: RenderSource
  /** Bắt buộc `"DRAFT"` khi `source = draft`, không có khi `source = baseline`. */
  watermark?: "DRAFT"
  /** ISO 8601. */
  generatedAt: string
  sections: RenderedSection[]
  recordOfChanges: RocRow[]
  /** In sau §I: đầy đủ khi `draft`; bản baseline chỉ in danh sách waive. */
  flagsAppendix?: FlagsAppendix
}
