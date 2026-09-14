/**
 * op.types.ts
 * ─────────────────────────────────────────────────────────────────
 * Hợp đồng op-based write (Phases §2.1, srs-spine.md §3) — ĐÓNG BĂNG tại M2.
 * T11 (draft-to-ops), T13 (step runner), T17 (change flow) import từ đây.
 *
 * Op mà model/user được phát: set · add · remove · renumber (khớp `opSchema`
 * của T03 trong `shared/ai/response-parser.ts`). `clone`/`migrate` là op hệ
 * thống (UC 1.15, T21) — thay cả nội dung Spine, path `$`.
 * `revert` chỉ do engine ghi khi `revertRange`; không nhận từ ngoài.
 */

import { z } from "zod"
import type { Change, Spine, SpineRecord } from "./spine.types.js"

// ─── op ──────────────────────────────────────────────────────────

export const USER_OP_KINDS = ["set", "add", "remove", "renumber"] as const
export const SYSTEM_OP_KINDS = ["clone", "migrate"] as const
export const OP_KINDS = [...USER_OP_KINDS, ...SYSTEM_OP_KINDS] as const

export type UserOpKind = (typeof USER_OP_KINDS)[number]
export type OpKind = (typeof OP_KINDS)[number]

/** Path gốc cho `clone`/`migrate`: thay toàn bộ nội dung Spine. */
export const ROOT_PATH = "$"

export const opSchema = z.strictObject({
  op: z.enum(OP_KINDS),
  /**
   * Path theo khoá, không theo chỉ số (srs-spine.md §1):
   * `actors[id=A03].name` · `permissions[screen_id=S3,role_id=R1,action=create]` ·
   * `screens[id=S07].flow_to[=S08]` (phần tử vô hướng) · `actors[]` (đích của add) ·
   * `features[]` (đích của renumber) · `$` (clone/migrate).
   */
  path: z.string().min(1),
  value: z.unknown().optional(),
  reason: z.string().optional()
})

/** Op do user/model phát — không có clone/migrate. */
export const userOpSchema = opSchema.extend({ op: z.enum(USER_OP_KINDS) })

export type Op = z.infer<typeof opSchema>
export type UserOp = z.infer<typeof userOpSchema>

// ─── transaction ─────────────────────────────────────────────────

export const transactionSchema = z.strictObject({
  /** Id lô; engine sinh UUID nếu thiếu. Mọi change trong lô mang cùng `txn`. */
  txn: z.string().min(1).optional(),
  /** `spine_version` caller đã đọc. Lệch ⇒ 409 SPINE_VERSION_CONFLICT. */
  base_version: z.number().int().min(1),
  ops: z.array(opSchema).min(1),
  /** Lý do chung, dùng khi op không có `reason` riêng. */
  reason: z.string().optional(),
  /** userId hoặc tác nhân hệ thống ("system"). */
  by: z.string().min(1),
  step_id: z.string().min(1).nullable().optional()
})

export type Transaction = z.infer<typeof transactionSchema>

// ─── change encoding ─────────────────────────────────────────────

/**
 * Đánh dấu "không có giá trị" trong `changes[].before/value`:
 * - `before = ABSENT` ⇒ op tạo mới (thêm phần tử, hoặc tạo key tuỳ chọn như `nfrs[].metric`).
 * - `value = {_absent: true, index}` ⇒ op xoá phần tử ở vị trí `index` (undo chèn lại đúng chỗ).
 * - `value = ABSENT` ⇒ op xoá key tuỳ chọn.
 * Không dùng `null` vì `null` là giá trị hợp lệ của field nullable.
 */
export const ABSENT_KEY = "_absent"

export interface AbsentMarker {
  _absent: true
  /** Vị trí phần tử trong mảng lúc bị xoá. Chỉ có với xoá phần tử. */
  index?: number
}

export const ABSENT: AbsentMarker = Object.freeze({ _absent: true }) as AbsentMarker

export const isAbsent = (value: unknown): value is AbsentMarker =>
  typeof value === "object" && value !== null && (value as Record<string, unknown>)[ABSENT_KEY] === true

// ─── lỗi ─────────────────────────────────────────────────────────

/**
 * `rule` là mã máy đọc được; test ca op T02 so khớp `must_reject` với nó.
 * Lỗi op (422 OP_INVALID): path_invalid, path_not_resolved, path_ambiguous,
 * index_selector_forbidden, key_change_forbidden, duplicate_id, op_value_missing,
 * op_not_allowed, schema_invalid.
 * Vi phạm bất biến (422 INVARIANT_VIOLATION): invariant_<n>_<tên>.
 */
export type RejectRule =
  | "path_invalid"
  | "path_not_resolved"
  | "path_ambiguous"
  | "index_selector_forbidden"
  | "key_change_forbidden"
  | "duplicate_id"
  | "op_value_missing"
  | "op_not_allowed"
  | "schema_invalid"
  | "invariant_1_required_section"
  | "invariant_2_last_element"
  | "invariant_3_dead_reference"
  | "invariant_4_screen_missing"
  | "invariant_5_feature_order"
  | "invariant_5_function_order"
  | "invariant_6_feature_mismatch"
  | "invariant_8_cursor_screen"
  | "invariant_8_screen_not_pending"
  | "invariant_8_screen_not_queued"

export interface Violation {
  rule: RejectRule
  message: string
  /** Path liên quan (op lỗi, hoặc phần tử vi phạm). */
  path?: string
  /** Vị trí op trong `txn.ops` khi lỗi thuộc một op cụ thể. */
  op_index?: number
}

/** Người đang tham chiếu phần tử bị xoá — trả cho user quyết (srs-spine.md §3). */
export interface Referrer {
  /** Path concrete tới field chứa khoá, ví dụ `screens[id=S03].feature_id`. */
  path: string
  /** Khoá bị tham chiếu. */
  id: string
}

export const OP_INVALID = "OP_INVALID"
export const INVARIANT_VIOLATION = "INVARIANT_VIOLATION"

// ─── kết quả ─────────────────────────────────────────────────────

/** Change chưa gắn `projectId` (engine sinh trước khi ghi). */
export type PlannedChange = Omit<Change, "projectId">

export interface ApplyResult {
  spine: SpineRecord
  changes: Change[]
  txn: string
  spine_version: number
}

export interface PreviewResult {
  ok: boolean
  txn: string
  base_version: number
  /** Lô đầy đủ sau khi mở rộng cascade — đúng thứ tự sẽ áp. */
  ops: Op[]
  /** Diff từng op: `{op, path, before, value, reason}` (seq chưa cấp). */
  changes: Omit<PlannedChange, "seq" | "at" | "by" | "txn" | "step_id">[]
  violations: Violation[]
  referrers: Referrer[]
}

/** Kết quả thuần của `planTransaction` (không đụng DB). */
export interface PlanResult {
  spine: Spine
  ops: Op[]
  changes: PlannedChange[]
}
