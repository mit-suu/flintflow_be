import mongoose from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sessions = vi.hoisted(() => ({ updateOne: vi.fn(), findOne: vi.fn() }))
const account = vi.hoisted(() => ({ locale: null as "vi" | "en" | null }))
vi.mock("./chat-session.model.js", () => ({ ChatSession: sessions }))
vi.mock("../user/account-locale.js", () => ({ accountLocaleOf: vi.fn(async () => account.locale) }))

import { replyLanguageForSession, replyLanguageForSessionId, typedPartOf } from "./reply-language.service.js"

const PROJECT = "650000000000000000000002"
const SESSION = "650000000000000000000003"
const USER = "650000000000000000000010"

const connected = (state: number) => vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(state as never)

beforeEach(() => {
  sessions.updateOne.mockReset().mockResolvedValue({})
  sessions.findOne.mockReset().mockReturnValue({ lean: async () => null })
  account.locale = null
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("replyLanguageForSession (phiên đã nạp)", () => {
  it("tin rõ ngôn ngữ ⇒ theo tin đó và ghi lên phiên", async () => {
    const session: { reply_language?: "vi" | "en" | null } = { reply_language: "vi" }
    expect(await replyLanguageForSession(session, "Can you explain the login flow?", USER)).toBe("en")
    expect(session.reply_language).toBe("en")
  })

  it("tin mơ hồ ⇒ giữ ngôn ngữ phiên, không ghi", async () => {
    const session: { reply_language?: "vi" | "en" | null } = { reply_language: "en" }
    expect(await replyLanguageForSession(session, "ok", USER)).toBe("en")
    expect(session.reply_language).toBe("en")
  })

  it("phiên chưa có ngôn ngữ + câu tiếng Anh ngắn ⇒ en (thắng tài khoản vi) và ghi lên phiên; phiên đã có thì không nới", async () => {
    account.locale = "vi"
    const fresh: { reply_language?: "vi" | "en" | null } = { reply_language: null }
    expect(await replyLanguageForSession(fresh, "A booking system for a dental clinic", USER)).toBe("en")
    expect(fresh.reply_language).toBe("en")

    const sticky: { reply_language?: "vi" | "en" | null } = { reply_language: "vi" }
    expect(await replyLanguageForSession(sticky, "A booking system for a dental clinic", USER)).toBe("vi")
  })

  it("phiên chưa có ⇒ ngôn ngữ tài khoản, phiên vẫn chưa có; tài khoản chưa chọn ⇒ vi", async () => {
    const session: { reply_language?: "vi" | "en" | null } = { reply_language: null }
    account.locale = "en"
    expect(await replyLanguageForSession(session, "ok", USER)).toBe("en")
    expect(session.reply_language).toBeNull()
    account.locale = null
    expect(await replyLanguageForSession(session, undefined, USER)).toBe("vi")
  })
})

describe("typedPartOf — chỉ đoán trên chữ user tự gõ, không trên nhãn thẻ AI viết", () => {
  const aiCard = JSON.stringify({
    reply: "Which hospital pilots first?",
    questions: [
      { question: "Which hospital?", options: [{ label: "Bạch Mai Hospital (Recommended)" }, { label: "Chợ Rẫy Hospital" }] },
      { question: "Platform?", options: [{ label: "Web app" }, { label: "Mobile" }] }
    ]
  })

  it("bỏ dòng chỉ gồm nhãn (một câu, đánh số, nhiều lựa chọn nối '; '), giữ chữ user gõ thêm", () => {
    expect(typedPartOf("Bạch Mai Hospital", aiCard)).toBe("")
    expect(typedPartOf("1. Bạch Mai Hospital\n2. Web app; Mobile", aiCard)).toBe("")
    expect(typedPartOf("1. Bạch Mai Hospital\n2. Web app\nPlease keep it simple", aiCard)).toBe("Please keep it simple")
    expect(typedPartOf("Bệnh viện khác ở Đà Nẵng", aiCard)).toBe("Bệnh viện khác ở Đà Nẵng")
  })

  it("tin AI trước không có thẻ / không phải JSON ⇒ giữ nguyên tin", () => {
    expect(typedPartOf("Bạch Mai Hospital", JSON.stringify({ reply: "ok", questions: [] }))).toBe("Bạch Mai Hospital")
    expect(typedPartOf("Bạch Mai Hospital", "plain text")).toBe("Bạch Mai Hospital")
    expect(typedPartOf("Bạch Mai Hospital", undefined)).toBe("Bạch Mai Hospital")
  })
})

describe("replyLanguageForSessionId (step runner)", () => {
  it("tin rõ ngôn ngữ ⇒ ghi reply_language vào đúng phiên của project", async () => {
    connected(1)
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "yes please" })).toBe("en")
    expect(sessions.updateOne).toHaveBeenCalledWith({ _id: SESSION, projectId: PROJECT }, { $set: { reply_language: "en" } })
  })

  it("tin mơ hồ ⇒ đọc ngôn ngữ phiên; phiên chưa có ⇒ tài khoản", async () => {
    connected(1)
    sessions.findOne.mockReturnValueOnce({ lean: async () => ({ reply_language: "en" }) })
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "ok" })).toBe("en")
    account.locale = "en"
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER })).toBe("en")
    expect(sessions.updateOne).not.toHaveBeenCalled()
  })

  it("phiên chưa có ngôn ngữ + câu tiếng Anh ngắn ⇒ en và ghi; phiên đã có thì giữ", async () => {
    connected(1)
    account.locale = "vi"
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "Booking app for dental clinic" })).toBe("en")
    expect(sessions.updateOne).toHaveBeenCalledWith({ _id: SESSION, projectId: PROJECT }, { $set: { reply_language: "en" } })

    sessions.updateOne.mockClear()
    sessions.findOne.mockReturnValueOnce({ lean: async () => ({ reply_language: "vi" }) })
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "Booking app for dental clinic" })).toBe("vi")
    expect(sessions.updateOne).not.toHaveBeenCalled()
  })

  it("chưa nối DB ⇒ không đụng phiên, vẫn theo tin vừa gõ", async () => {
    connected(0)
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "Đúng vậy" })).toBe("vi")
    expect(sessions.updateOne).not.toHaveBeenCalled()
    expect(sessions.findOne).not.toHaveBeenCalled()
  })

  it("ghi lỗi ⇒ không ném lỗi, vẫn trả ngôn ngữ đoán được", async () => {
    connected(1)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    sessions.updateOne.mockRejectedValue(new Error("mất kết nối"))
    expect(await replyLanguageForSessionId({ projectId: PROJECT, sessionId: SESSION, userId: USER, message: "thank you" })).toBe("en")
  })
})
