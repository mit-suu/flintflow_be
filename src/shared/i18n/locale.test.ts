import { describe, expect, it } from "vitest"
import { isUserLocale, toUserLocale, USER_LOCALES } from "./locale.js"

describe("locale của tài khoản", () => {
  it("chỉ nhận vi và en", () => {
    expect(USER_LOCALES).toEqual(["vi", "en"])
    expect(isUserLocale("vi")).toBe(true)
    expect(isUserLocale("en")).toBe(true)
    for (const value of ["fr", "VI", "", null, undefined, 1]) expect(isUserLocale(value)).toBe(false)
  })

  it("thiếu hoặc giá trị lạ ⇒ null (tài khoản chưa chọn)", () => {
    expect(toUserLocale("en")).toBe("en")
    expect(toUserLocale(undefined)).toBeNull()
    expect(toUserLocale(null)).toBeNull()
    expect(toUserLocale("fr")).toBeNull()
  })
})
