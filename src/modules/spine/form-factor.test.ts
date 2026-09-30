import { describe, expect, it } from "vitest"
import { normalizeFormFactor, normalizeFormFactorAt } from "./form-factor.js"

describe("normalizeFormFactor", () => {
  it("chuỗi ⇒ mảng một phần tử; null/rỗng ⇒ []; mảng bỏ trùng giữ thứ tự", () => {
    expect(normalizeFormFactor("web_app")).toEqual(["web_app"])
    expect(normalizeFormFactor(" web_app ")).toEqual(["web_app"])
    expect(normalizeFormFactor(null)).toEqual([])
    expect(normalizeFormFactor("")).toEqual([])
    expect(normalizeFormFactor(["mobile_app", "web_app", "mobile_app", ""])).toEqual(["mobile_app", "web_app"])
    expect(normalizeFormFactor(42)).toEqual([])
  })
})

describe("normalizeFormFactorAt", () => {
  it("chuẩn hoá theo path project.form_factor / project / gốc; path khác giữ nguyên", () => {
    expect(normalizeFormFactorAt("project.form_factor", "web_app")).toEqual(["web_app"])
    expect(normalizeFormFactorAt("project", { name: "P", form_factor: null })).toEqual({ name: "P", form_factor: [] })
    expect(normalizeFormFactorAt("$", { project: { form_factor: "web_app" }, actors: [] })).toEqual({ project: { form_factor: ["web_app"] }, actors: [] })
    expect(normalizeFormFactorAt("project.stakes", "internal")).toBe("internal")
    const absent = { __absent: true }
    expect(normalizeFormFactorAt("project", absent)).toBe(absent)
  })
})
