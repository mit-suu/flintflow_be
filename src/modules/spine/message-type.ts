/**
 * P07: loại thông báo (`messages[].type`) — chuẩn hoá chữ của cột "Type" / "Message Type" trong file upload ("Error",
 * "Lỗi", "Confirmation"…) về enum của Spine, và nhãn in vào cột đó.
 */

import type { MessageType } from "./spine.types.js"

const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim()

const PATTERNS: readonly [MessageType, RegExp][] = [
  ["error", /^(err|error|loi|thong bao loi|failure|fail|that bai)\b/],
  ["warning", /^(warn|warning|canh bao|alert)\b/],
  ["success", /^(success|successful|thanh cong|ok)\b/],
  ["confirm", /^(confirm|confirmation|question|xac nhan|hoi)\b/],
  ["info", /^(info|information|informational|notice|notification|thong tin|thong bao)\b/]
]

/** Chữ của ô "Type" ⇒ enum; không nhận ra ⇒ `null` (không đoán). */
export const messageTypeOf = (value: unknown): MessageType | null => {
  if (typeof value !== "string") return null
  const t = fold(value)
  if (!t) return null
  return PATTERNS.find(([, re]) => re.test(t))?.[0] ?? null
}

const LABELS: Readonly<Record<"en" | "vi", Record<MessageType, string>>> = {
  en: { error: "Error", warning: "Warning", info: "Information", success: "Success", confirm: "Confirmation" },
  vi: { error: "Lỗi", warning: "Cảnh báo", info: "Thông tin", success: "Thành công", confirm: "Xác nhận" }
}

/** Nhãn in cột "Type" theo ngôn ngữ tài liệu; Spine cũ không có loại ⇒ "". */
export const messageTypeLabel = (type: MessageType | null | undefined, language: "en" | "vi" = "en"): string =>
  type ? LABELS[language][type] : ""
