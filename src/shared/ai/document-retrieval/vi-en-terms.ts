/**
 * Mở rộng câu hỏi tìm đoạn qua hai ngôn ngữ (FLF-393) — hàm thuần, bảng cố định.
 *
 * Người dùng hỏi tiếng Việt trên SRS tiếng Anh (và ngược lại) là ca thường gặp: "tài liệu có nói cổng thanh toán nào
 * không?" trên SRS viết "Payment Gateway … VietQR / SePay checkout". BM25 không nối được hai ngôn ngữ — demo 2026-11-12,
 * chỉ chữ "credit" khớp nên đoạn đúng không được gửi. Bảng này nối các thuật ngữ nghiệp vụ / SRS hay gặp: câu hỏi chứa
 * cụm của một bên ⇒ thêm cụm của bên kia vào câu hỏi. So khớp trên chữ đã bỏ dấu, theo ranh giới từ.
 *
 * Không thay được tìm theo nghĩa (vector) — chỉ phủ từ vựng phổ biến; thêm dòng khi gặp ca thật.
 */

import { foldDiacritics } from "./vi-tokenizer.js"

/** Mỗi dòng: [cụm tiếng Việt, cụm tiếng Anh] — dòng nào khớp ở một bên thì thêm cả bên kia. */
export const VI_EN_TERMS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["thanh toán", "trả tiền"], ["payment", "pay", "checkout"]],
  [["cổng thanh toán"], ["payment gateway"]],
  [["nạp tiền", "nạp credit", "nạp", "mua credit", "mua gói"], ["top up", "purchase", "buy credits", "credit pack"]],
  [["hoá đơn", "hóa đơn"], ["invoice", "bill"]],
  [["hoàn tiền"], ["refund"]],
  [["ví"], ["wallet"]],
  [["gói", "gói dịch vụ", "gói cước"], ["plan", "subscription", "package"]],
  [["đăng nhập"], ["login", "log in", "sign in"]],
  [["đăng xuất"], ["logout", "log out", "sign out"]],
  [["đăng ký"], ["register", "registration", "sign up"]],
  [["mật khẩu"], ["password"]],
  [["quên mật khẩu", "đặt lại mật khẩu"], ["forgot password", "reset password"]],
  [["tài khoản"], ["account"]],
  [["người dùng"], ["user"]],
  [["khách hàng"], ["customer", "client"]],
  [["quản trị", "quản trị viên"], ["admin", "administrator"]],
  [["vai trò"], ["role"]],
  [["phân quyền", "quyền"], ["permission", "authorization", "access control"]],
  [["tổ chức"], ["organization"]],
  [["thành viên"], ["member"]],
  [["lời mời", "mời"], ["invitation", "invite"]],
  [["thông báo"], ["notification", "message"]],
  [["email", "thư"], ["email"]],
  [["tìm kiếm"], ["search"]],
  [["báo cáo", "thống kê"], ["report", "statistics", "dashboard"]],
  [["xuất file", "xuất", "tải xuống"], ["export", "download"]],
  [["tải lên", "upload"], ["upload"]],
  [["tài liệu"], ["document"]],
  [["màn hình", "giao diện"], ["screen", "interface", "ui"]],
  [["chức năng", "tính năng"], ["function", "feature"]],
  [["ca sử dụng"], ["use case"]],
  [["tác nhân"], ["actor"]],
  [["quy tắc", "luật nghiệp vụ", "quy tắc nghiệp vụ"], ["business rule", "rule"]],
  [["yêu cầu phi chức năng"], ["non-functional requirement", "nfr"]],
  [["hiệu năng"], ["performance"]],
  [["bảo mật", "an toàn"], ["security", "privacy"]],
  [["độ tin cậy", "sẵn sàng"], ["reliability", "availability"]],
  [["tuân thủ", "pháp lý", "pháp luật", "quy định"], ["compliance", "legal", "regulation"]],
  [["dữ liệu cá nhân"], ["personal data", "privacy"]],
  [["nền tảng"], ["platform", "web-based", "browser", "mobile", "desktop"]],
  [["trình duyệt"], ["browser", "web"]],
  [["di động", "điện thoại"], ["mobile"]],
  [["lịch hẹn", "đặt lịch", "lịch"], ["appointment", "booking", "schedule"]],
  [["đơn hàng"], ["order"]],
  [["sản phẩm"], ["product"]],
  [["giỏ hàng"], ["cart"]],
  [["phê duyệt", "duyệt"], ["approve", "approval", "review"]],
  [["từ chối"], ["reject"]],
  [["lịch sử", "nhật ký"], ["history", "log", "audit"]],
  [["sao lưu"], ["backup"]],
  [["tích hợp", "hệ thống ngoài"], ["integration", "external system"]],
  [["thuật ngữ"], ["glossary", "term"]],
  [["phạm vi"], ["scope"]],
  [["mục tiêu"], ["goal", "objective"]],
  [["tổng quan"], ["overview"]]
]

const fold = (s: string): string => foldDiacritics(s.normalize("NFC")).toLowerCase()

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Cụm có trong chữ (đã gập dấu) theo ranh giới từ. */
const mentions = (foldedText: string, phrase: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(fold(phrase))}(?![\\p{L}\\p{N}])`, "u").test(foldedText)

/** Các cụm của ngôn ngữ kia cần thêm vào câu hỏi (không lặp, không gồm cụm câu hỏi đã có). */
export const crossLanguageTerms = (query: string): string[] => {
  const text = fold(query)
  const extra = new Set<string>()
  for (const [vi, en] of VI_EN_TERMS) {
    const viHit = vi.some((p) => mentions(text, p))
    const enHit = en.some((p) => mentions(text, p))
    if (viHit) for (const p of en) if (!mentions(text, p)) extra.add(p)
    if (enHit) for (const p of vi) if (!mentions(text, p)) extra.add(p)
  }
  return [...extra]
}

/** Câu hỏi + cụm tương ứng của ngôn ngữ kia. */
export const expandCrossLanguage = (query: string): string => {
  const extra = crossLanguageTerms(query)
  return extra.length ? `${query}\n${extra.join("\n")}` : query
}
