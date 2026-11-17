import { describe, expect, it } from "vitest"
import { messageTypeLabel, messageTypeOf } from "./message-type.js"

describe("messageTypeOf (P07)", () => {
  it("nhận chữ tiếng Anh và tiếng Việt của cột Type", () => {
    expect(messageTypeOf("Error")).toBe("error")
    expect(messageTypeOf("Lỗi")).toBe("error")
    expect(messageTypeOf("Warning")).toBe("warning")
    expect(messageTypeOf("Cảnh báo")).toBe("warning")
    expect(messageTypeOf("Info")).toBe("info")
    expect(messageTypeOf("Thông tin")).toBe("info")
    expect(messageTypeOf("Success")).toBe("success")
    expect(messageTypeOf("Thành công")).toBe("success")
    expect(messageTypeOf("Confirmation")).toBe("confirm")
    expect(messageTypeOf("Xác nhận")).toBe("confirm")
  })

  it("chữ lạ / rỗng / không phải chuỗi ⇒ null, không đoán", () => {
    expect(messageTypeOf("Toast")).toBeNull()
    expect(messageTypeOf("")).toBeNull()
    expect(messageTypeOf(undefined)).toBeNull()
    expect(messageTypeOf(3)).toBeNull()
  })

  it("nhãn theo ngôn ngữ; không có loại ⇒ ô trống", () => {
    expect(messageTypeLabel("error")).toBe("Error")
    expect(messageTypeLabel("confirm", "vi")).toBe("Xác nhận")
    expect(messageTypeLabel(null)).toBe("")
    expect(messageTypeLabel(undefined, "vi")).toBe("")
  })
})
