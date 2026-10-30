/**
 * Máy trạng thái import (mode 1, Flow 1 nút 1.1–1.13) — hàm thuần, không đụng DB. FLF-171, plan §5.2.
 *
 * FLF-343 — chế độ 1 chạy một mạch: một điểm dừng duy nhất là `extracting` chưa chạy (màn báo credit + câu hỏi "bản mới
 * nhất"), rồi I-4 ⇒ baseline 0.1 ⇒ kiểm tra ⇒ `gap_review` (FE vào thẳng trang tạo CR) không chờ người dùng:
 * uploaded ─┬─ preflight_rejected                        (1.2 bị từ chối — user upload file khác = bản ghi mới)
 *           └─ parsing ─► extracting                    (tách file + khớp mẫu; mục độ tin thấp tự nhận + cờ "Cần xem")
 * extracting ─► baselining                              (job I-4 xong ⇒ job finalize nối tiếp, base_version do server tính)
 * baselining ─► checking ─► gap_review                  (1.10 → 1.11/1.12)
 * Bản ghi cũ (trước FLF-343) còn đi được nhánh: uploaded ─► awaiting_latest_confirm ─► parsing ─► mapping_review ─►
 * extracting ─► fields_review ─► baselining — `POST /import/extract` / `/import/resume` đưa chúng về luồng một mạch.
 * gap_review ─► delivered | change_requested
 * delivered ─► change_requested                         (giao gap report xong, sau đó mới quyết định sửa)
 * incomplete ─► drafting                                (FLF-278 trên FLF-336: chế độ 3 sang Luồng 2 — dự án chạy pipeline
 *                                                        tạo mới cho phần thiếu; ký baseline 1.0 ⇒ FLF-318 đưa về mode 1)
 *
 * `paused` là field riêng (`{ reason, at }`), chỉ đặt được khi đang `extracting` hoặc `checking`
 * (hai bước gọi AI, Flow 4/5), hoặc `baselining` khi job finalize nền lỗi / mất giữa chừng (chỉ `resume_later`).
 * Trạng thái không đổi khi pause; resume chạy tiếp từ `extract_cursor` / chạy lại finalize từ mốc.
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
  /** FLF-336 I-5: file thiếu mục của cấu trúc đích ⇒ không có v0 dở dang, dừng ở "Kết quả đọc file" (Dừng / Hoàn thiện). */
  "incomplete",
  /** FLF-278: chế độ 3 (mẫu bắt buộc) đi tiếp Luồng 2 — soạn phần thiếu bằng pipeline, không tạo v0 từ mẫu. */
  "drafting",
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
  incomplete: "Chưa hoàn thiện — chờ bạn quyết",
  drafting: "Đang soạn phần còn thiếu",
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
  // FLF-343: tách file lỗi ⇒ preflight_rejected (issue PARSE_FAILED), người dùng tải file khác
  parsing: ["mapping_review", "extracting", "preflight_rejected"],
  mapping_review: ["extracting"],
  extracting: ["fields_review", "baselining"],
  fields_review: ["baselining"],
  baselining: ["checking", "incomplete"],
  incomplete: ["baselining", "drafting"],
  drafting: ["delivered"],
  checking: ["gap_review"],
  gap_review: ["delivered", "change_requested"],
  delivered: ["change_requested"],
  change_requested: []
}

/**
 * Hai bước có gọi AI (I-4 trích field, 1.11 AI semantic check) — hết credit/lỗi AI thì pause. `baselining`: job finalize
 * chạy nền lỗi hoặc mất (máy chủ khởi động lại) ⇒ hoàn về mốc + `resume_later`, resume chạy lại finalize (`finalize-jobs.ts`).
 */
export const PAUSABLE_IMPORT_STATUSES: readonly ImportStatus[] = ["extracting", "baselining", "checking"]

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
