import mongoose from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const users = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock("./user.model.js", () => ({ User: users }))

import { accountLocaleOf } from "./account-locale.js"

const connected = (state: number) => vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(state as never)

beforeEach(() => {
  users.findById.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("accountLocaleOf", () => {
  it("đã nối DB ⇒ đọc locale đã lưu", async () => {
    connected(1)
    users.findById.mockReturnValue({ lean: async () => ({ locale: "en" }) })
    expect(await accountLocaleOf("650000000000000000000010")).toBe("en")
    expect(users.findById).toHaveBeenCalledWith("650000000000000000000010", { locale: 1 })
  })

  it("tài khoản chưa chọn / không tồn tại ⇒ null", async () => {
    connected(1)
    users.findById.mockReturnValueOnce({ lean: async () => ({}) }).mockReturnValueOnce({ lean: async () => null })
    expect(await accountLocaleOf("650000000000000000000010")).toBeNull()
    expect(await accountLocaleOf("650000000000000000000011")).toBeNull()
  })

  it("chưa nối DB hoặc không có userId ⇒ null, không truy vấn", async () => {
    connected(0)
    expect(await accountLocaleOf("650000000000000000000010")).toBeNull()
    connected(1)
    expect(await accountLocaleOf(undefined)).toBeNull()
    expect(users.findById).not.toHaveBeenCalled()
  })

  it("đọc lỗi ⇒ null, không ném lỗi", async () => {
    connected(1)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    users.findById.mockReturnValue({ lean: async () => Promise.reject(new Error("mất kết nối")) })
    expect(await accountLocaleOf("650000000000000000000010")).toBeNull()
  })
})
