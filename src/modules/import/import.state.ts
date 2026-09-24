/**
 * Máy trạng thái import (mode 1, Flow 1 nút 1.1–1.13) — hàm thuần, không đụng DB. FLF-171, plan §5.2.
 *
 * uploaded ─┬─ preflight_rejected                        (1.2 bị từ chối — user upload file khác = bản ghi mới)
 *           ├─ awaiting_latest_confirm ─► parsing       (1.3 file không có stamp)
 *           └─ parsing                                  (đã xác nhận)
 * parsing ─► mapping_review | extracting                (1.6 độ tin thấp ⇒ 1.7)
 * mapping_review ─► extracting
 * extracting ─► fields_review | baselining              (1.8 độ tin thấp ⇒ 1.9)
 * fields_review ─► baselining ─► checking ─► gap_review (1.10 → 1.11/1.12 → 1.13)
 * gap_review ─► delivered | change_requested
 * delivered ─► change_requested                         (giao gap report xong, sau đó mới quyết định sửa)
 *
 * `paused` là field riêng (`{ reason, at }`), chỉ đặt được khi đang `extracting` hoặc `checking`
 * (hai bước gọi AI, Flow 4/5). Trạng thái không đổi khi pause; resume chạy tiếp từ `extract_cursor`.
 */

import { Mode1Error } from "./mode1.errors.js"

export const IMPORT_STATUSES = [
  "uploaded",
  "preflight_rejected",
  "awaiting_latest_confirm",
  "parsing",
  "mapping_review",
  "extracting",
  "fields_review",
  "baselining",
  "checking",
  "gap_review",
  "delivered",
  "change_requested"
] as const

export type ImportStatus = (typeof IMPORT_STATUSES)[number]

/** Tên trạng thái cho câu chữ gửi người dùng — không in mã enum (`mapping_review`). */
export const IMPORT_STATUS_LABELS: Readonly<Record<ImportStatus, string>> = {
  uploaded: "Vừa tải lên",
  preflight_rejected: "File bị từ chối",
  awaiting_latest_confirm: "Chờ xác nhận bản mới nhất",
  parsing: "Đang đọc tài liệu",
  mapping_review: "Xác nhận khớp mục",
  extracting: "Đang trích dữ liệu",
  fields_review: "Duyệt dữ liệu trích",
  baselining: "Đang chốt bản gốc",
  checking: "Đang kiểm tra",
  gap_review: "Xem báo cáo thiếu sót",
  delivered: "Đã giao báo cáo",
  change_requested: "Đang sửa qua change request"
}

export const IMPORT_PAUSE_REASONS = ["credits", "resume_later"] as const
export type ImportPauseReason = (typeof IMPORT_PAUSE_REASONS)[number]

export const IMPORT_TRANSITIONS: Readonly<Record<ImportStatus, readonly ImportStatus[]>> = {
  uploaded: ["preflight_rejected", "awaiting_latest_confirm", "parsing"],
  preflight_rejected: [],
  awaiting_latest_confirm: ["parsing"],
  parsing: ["mapping_review", "extracting"],
  mapping_review: ["extracting"],
  extracting: ["fields_review", "baselining"],
  fields_review: ["baselining"],
  baselining: ["checking"],
  checking: ["gap_review"],
  gap_review: ["delivered", "change_requested"],
  delivered: ["change_requested"],
  change_requested: []
}

/** Hai bước có gọi AI (I-4 trích field, 1.11 AI semantic check) — hết credit/lỗi AI thì pause. */
export const PAUSABLE_IMPORT_STATUSES: readonly ImportStatus[] = ["extracting", "checking"]

/** Đã có baseline v0 (từ `checking` trở đi) — BR-03: mọi sửa sau đây phải qua CR. */
export const IMPORT_STATUSES_WITH_BASELINE: readonly ImportStatus[] = ["checking", "gap_review", "delivered", "change_requested"]

export const canTransition = (from: ImportStatus, to: ImportStatus): boolean => IMPORT_TRANSITIONS[from].includes(to)

export const assertTransition = (from: ImportStatus, to: ImportStatus): void => {
  if (!canTransition(from, to)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", `Không chuyển được lần nhập tài liệu từ bước "${IMPORT_STATUS_LABELS[from] ?? from}" sang "${IMPORT_STATUS_LABELS[to] ?? to}"`, {
      status: from,
      to,
      allowed: IMPORT_TRANSITIONS[from]
    })
  }
}

export const isTerminal = (status: ImportStatus): boolean => IMPORT_TRANSITIONS[status].length === 0

export const canPause = (status: ImportStatus): boolean => PAUSABLE_IMPORT_STATUSES.includes(status)

export const hasBaseline = (status: ImportStatus): boolean => IMPORT_STATUSES_WITH_BASELINE.includes(status)
