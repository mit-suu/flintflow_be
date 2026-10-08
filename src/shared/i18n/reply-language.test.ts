import { describe, expect, it } from "vitest"
import {
  byLanguage,
  DEFAULT_REPLY_LANGUAGE,
  detectMessageLanguage,
  replyLanguageDirective,
  resolveReplyLanguage
} from "./reply-language.js"
import { RECOMMENDED_SUFFIX } from "../../modules/pipeline/decisions.service.js"

describe("detectMessageLanguage", () => {
  it.each([
    "Tài liệu này đang thiếu gì?",
    "được",
    "ok bạn",
    "Đổi tên actor A01 thành Product Owner",
    "Thêm use case đăng nhập cho actor Admin",
    "Mình chưa có ý tưởng cụ thể.",
    "Mình muốn the app support English",
    "tai lieu nay dang thieu gi",
    "minh muon lam app quan ly cong viec",
    "Hệ thống cho Bệnh viện Đa khoa tỉnh",
    "được".normalize("NFD")
  ])("tiếng Việt: %s", (text) => {
    expect(detectMessageLanguage(text)).toBe("vi")
  })

  it.each([
    "What does UC-01 do?",
    "Can you explain the login flow?",
    "Please update the résumé and café screens",
    "Please ask Nguyễn Văn An about it",
    "thank you",
    "yes please",
    "Looks good",
    "I don't have a specific idea yet.",
    "I want to build an app that helps a small team assign tasks",
    "Please rename actor A01 to Product Owner",
    "ok, the app should support Vietnamese and English",
    "Rename the actor A01 to Student",
    "Add a reminder screen for the receptionist",
    "Rename actor Learner to Nguyễn Văn A"
  ])("tiếng Anh: %s", (text) => {
    expect(detectMessageLanguage(text)).toBe("en")
  })

  it.each([
    "co the thanh toan bang the",
    "co the to chuc",
    "Cho phép export to PDF and Excel",
    "Phải có audit log for every action",
    "Cần support offline mode for the mobile app",
    "Cần có search and filter for all products",
    "Update màn hình login cho admin",
    "Add thêm cho mình 1 actor nữa",
    "update screen login"
  ])("người Việt chêm tiếng Anh / gõ không dấu — không bao giờ ra en: %s", (text) => {
    expect(detectMessageLanguage(text)).not.toBe("en")
    expect(detectMessageLanguage(text, { lenient: true })).not.toBe("en")
  })

  it("chế độ nới (phiên chưa có ngôn ngữ): câu tiếng Anh ngắn cũng đủ, câu có chút tiếng Việt thì không", () => {
    for (const text of ["A booking system for a dental clinic", "Patients pay online by card", "Booking app for dental clinic"]) {
      expect(detectMessageLanguage(text)).toBeNull()
      expect(detectMessageLanguage(text, { lenient: true })).toBe("en")
    }
    for (const text of ["ok", "Doctors and receptionists", "app quan ly cong viec for team", "web app cho bệnh viện"]) {
      expect(detectMessageLanguage(text, { lenient: true })).not.toBe("en")
    }
  })

  it.each([
    "",
    "   ",
    "ok",
    "OK!",
    "yes",
    "sure",
    "thanks",
    "123",
    "99.9%",
    "UC-01",
    "S-5.2@S03",
    "login screen",
    "web",
    "```ts\nconst x = 1\n```",
    "`npm run dev`",
    "https://flintflow.app/projects/x",
    "hiep@flintflow.vn",
    "[Đính kèm tài liệu]",
    "👍",
    null,
    undefined
  ])("mơ hồ ⇒ null: %j", (text) => {
    expect(detectMessageLanguage(text)).toBeNull()
  })
})

describe("resolveReplyLanguage", () => {
  it("ứng viên hợp lệ đầu tiên thắng: tin vừa gõ → phiên → tài khoản", () => {
    expect(resolveReplyLanguage("en", "vi", "vi")).toBe("en")
    expect(resolveReplyLanguage(null, "en", "vi")).toBe("en")
    expect(resolveReplyLanguage(null, undefined, "en")).toBe("en")
  })

  it("không có gì hợp lệ ⇒ tiếng Việt", () => {
    expect(resolveReplyLanguage()).toBe("vi")
    expect(resolveReplyLanguage(null, "fr", undefined)).toBe(DEFAULT_REPLY_LANGUAGE)
  })
})

describe("byLanguage", () => {
  it("chọn câu theo ngôn ngữ", () => {
    const texts = { vi: "Xin chào", en: "Hello" }
    expect(byLanguage("vi", texts)).toBe("Xin chào")
    expect(byLanguage("en", texts)).toBe("Hello")
  })
})

describe("replyLanguageDirective", () => {
  it("nêu rõ ngôn ngữ và đuôi khuyến nghị — đuôi đó parser của BE đã nhận", () => {
    const en = replyLanguageDirective("en")
    const vi = replyLanguageDirective("vi")
    expect(en).toContain("Reply language: **English**")
    expect(vi).toContain("Reply language: **Vietnamese (tiếng Việt)**")
    expect(`Web (Recommended)`).toMatch(RECOMMENDED_SUFFIX)
    expect(en).toContain("` (Recommended)`")
    expect(vi).toContain("` (Khuyến nghị)`")
  })

  it("không chứa từ mà mock provider dò để chọn kiểu trả lời", () => {
    for (const text of [replyLanguageDirective("en"), replyLanguageDirective("vi")]) {
      for (const sniffed of ["Tóm tắt", "summarize", "Trích xuất", "extract"]) expect(text).not.toContain(sniffed)
    }
  })
})
