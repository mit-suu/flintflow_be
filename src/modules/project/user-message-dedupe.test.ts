import { describe, it, expect, beforeEach } from "vitest"
import { DUPLICATE_WINDOW_MS, claimUserMessage, resetUserMessageClaims } from "./user-message-dedupe.js"

beforeEach(() => resetUserMessageClaims())

describe("claimUserMessage (FLF-400)", () => {
  it("lượt đầu còn đang xử lý ⇒ tin trùng (cùng phiên + bước + nội dung, bỏ khoảng trắng hai đầu) bị chặn", () => {
    expect(claimUserMessage("s1", "chat", "Xin chào")).not.toBeNull()
    expect(claimUserMessage("s1", "chat", "  Xin chào ")).toBeNull()
  })

  it("khác phiên / khác bước / khác nội dung ⇒ không phải tin trùng", () => {
    expect(claimUserMessage("s1", "chat", "Xin chào")).not.toBeNull()
    expect(claimUserMessage("s2", "chat", "Xin chào")).not.toBeNull()
    expect(claimUserMessage("s1", "B-1.5", "Xin chào")).not.toBeNull()
    expect(claimUserMessage("s1", "chat", "Xin chào bạn")).not.toBeNull()
  })

  it("release(false) ⇒ nhả ngay, gửi lại được liền", () => {
    claimUserMessage("s1", "chat", "Xin chào")!.release(false)
    expect(claimUserMessage("s1", "chat", "Xin chào")).not.toBeNull()
  })

  it("release(true) ⇒ chặn tiếp trong cửa sổ, quá cửa sổ thì nhận lại", () => {
    const start = Date.now()
    claimUserMessage("s1", "chat", "Xin chào", start)!.release(true)
    expect(claimUserMessage("s1", "chat", "Xin chào", start + 1)).toBeNull()
    expect(claimUserMessage("s1", "chat", "Xin chào", start + DUPLICATE_WINDOW_MS + 1_000)).not.toBeNull()
  })

  it("release gọi hai lần không nhả nhầm chỗ giữ của lượt sau", () => {
    const first = claimUserMessage("s1", "chat", "Xin chào")!
    first.release(false)
    expect(claimUserMessage("s1", "chat", "Xin chào")).not.toBeNull()
    first.release(false)
    expect(claimUserMessage("s1", "chat", "Xin chào")).toBeNull()
  })
})
