/**
 * Máy trạng thái change request mode 1 (Flow 3 nút 3.1–3.14) — hàm thuần, không đụng DB. FLF-171, plan §5.4.
 *
 * draft ─► clarifying ⇄ awaiting_answers                 (C-2 làm rõ; tối đa 3 vòng rồi bắt buộc đi tiếp)
 * clarifying ─► impact_review                            (C-3 tìm vị trí + 3.5 khoá block)
 * impact_review ─► proposing ─► verifying                (C-4 đề xuất, C-5 kiểm)
 * verifying ─► ready_to_submit | proposing | manual_fix  (đạt · AI làm lại, redo ≤ 2 · vẫn trượt ⇒ sửa tay 3.9)
 * manual_fix ─► verifying ;  ready_to_submit ─► verifying (user sửa đề xuất sau khi đã đạt)
 * ready_to_submit ─► in_review                           (3.11 nộp; G1: người tạo tự duyệt)
 * in_review ─► written | proposing | rejected            (3.14 ghi · sửa lại khi mọi group bị từ chối · 3.13 đóng)
 * mọi trạng thái chưa kết thúc ─► cancelled              (3.10, UC-53 — kể cả khi đang paused)
 *
 * `paused` là field riêng, chỉ đặt ở bước gọi AI (clarifying, proposing, verifying). Khoá block giữ nguyên khi pause.
 */

import { Mode1Error } from "../import/mode1.errors.js"

export const CR_STATUSES = [
  "draft",
  "clarifying",
  "awaiting_answers",
  "impact_review",
  "proposing",
  "verifying",
  "manual_fix",
  "ready_to_submit",
  "in_review",
  "written",
  "rejected",
  "cancelled"
] as const

export type CrStatus = (typeof CR_STATUSES)[number]

export const CR_PAUSE_REASONS = ["credits", "resume_later"] as const
export type CrPauseReason = (typeof CR_PAUSE_REASONS)[number]

/** Cạnh tiến theo plan §5.4 + huỷ (`cancelled`) từ mọi trạng thái chưa kết thúc. */
export const CR_TRANSITIONS: Readonly<Record<CrStatus, readonly CrStatus[]>> = {
  draft: ["clarifying", "cancelled"],
  clarifying: ["awaiting_answers", "impact_review", "cancelled"],
  awaiting_answers: ["clarifying", "cancelled"],
  impact_review: ["proposing", "cancelled"],
  proposing: ["verifying", "cancelled"],
  verifying: ["ready_to_submit", "proposing", "manual_fix", "cancelled"],
  manual_fix: ["verifying", "cancelled"],
  ready_to_submit: ["in_review", "verifying", "cancelled"],
  in_review: ["written", "proposing", "rejected", "cancelled"],
  written: [],
  rejected: [],
  cancelled: []
}

/** Bước gọi AI (Flow 4/5) — hết credit / lỗi AI 2 lần thì pause. */
export const PAUSABLE_CR_STATUSES: readonly CrStatus[] = ["clarifying", "proposing", "verifying"]

/** Từ lúc tìm xong vị trí (3.5 khoá) tới khi ghi/đóng/huỷ, CR giữ khoá block. */
export const CR_STATUSES_HOLDING_LOCKS: readonly CrStatus[] = [
  "impact_review",
  "proposing",
  "verifying",
  "manual_fix",
  "ready_to_submit",
  "in_review"
]

/** Số vòng làm rõ tối đa (C-2); quá thì bắt buộc đi tiếp sang impact_review. */
export const MAX_CLARIFY_ROUNDS = 3

/** Số lần AI làm lại một vị trí trượt verify (C-5) trước khi chuyển sửa tay. */
export const MAX_REDO_PER_LOCATION = 2

export const canTransition = (from: CrStatus, to: CrStatus): boolean => CR_TRANSITIONS[from].includes(to)

export const assertTransition = (from: CrStatus, to: CrStatus): void => {
  if (!canTransition(from, to)) {
    throw new Mode1Error("CR_INVALID_TRANSITION", `Không chuyển được change request từ "${from}" sang "${to}"`, {
      status: from,
      to,
      allowed: CR_TRANSITIONS[from]
    })
  }
}

export const isTerminal = (status: CrStatus): boolean => CR_TRANSITIONS[status].length === 0

export const canPause = (status: CrStatus): boolean => PAUSABLE_CR_STATUSES.includes(status)

export const holdsLocks = (status: CrStatus): boolean => CR_STATUSES_HOLDING_LOCKS.includes(status)

/** Sau `round` vòng hỏi–đáp, AI còn được hỏi tiếp không (nếu không ⇒ clarifying đi thẳng impact_review). */
export const canAskMore = (round: number): boolean => round < MAX_CLARIFY_ROUNDS

/** Vị trí trượt verify lần thứ `redoCount + 1`: AI làm lại hay chuyển sửa tay. */
export const nextAfterVerifyFail = (redoCount: number): Extract<CrStatus, "proposing" | "manual_fix"> =>
  redoCount < MAX_REDO_PER_LOCATION ? "proposing" : "manual_fix"
