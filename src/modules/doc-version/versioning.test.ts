import { describe, it, expect } from "vitest"
import {
  compareDocVersions,
  downloadFileName,
  isDocVersion,
  isReleaseVersion,
  nextMajor,
  nextMinor,
  parseDocVersion
} from "./versioning.js"

describe("versioning — G4", () => {
  it.each([
    ["0.0", "0.1"],
    ["0.2", "0.3"],
    ["0.9", "0.10"],
    ["1.0", "1.1"],
    ["2.14", "2.15"]
  ])("nextMinor(%s) = %s", (current, expected) => {
    expect(nextMinor(current)).toBe(expected)
  })

  it.each([
    ["0.0", "1.0"],
    ["0.3", "1.0"],
    ["1.0", "2.0"],
    ["1.4", "2.0"],
    ["9.12", "10.0"]
  ])("nextMajor(%s) = %s", (current, expected) => {
    expect(nextMajor(current)).toBe(expected)
  })

  it("chỉ nhận dạng major.minor, không số 0 thừa, không tiền tố v", () => {
    for (const ok of ["0.0", "0.1", "1.0", "10.25"]) expect(isDocVersion(ok), ok).toBe(true)
    for (const bad of ["v1.0", "1", "1.0.0", "01.0", "1.01", "1.0-conditional", ""]) expect(isDocVersion(bad), bad).toBe(false)
    expect(() => parseDocVersion("v1.0")).toThrow(/major.minor/)
    expect(() => nextMinor("v1.1")).toThrow()
  })

  it("sắp xếp theo số, không theo chuỗi (0.10 mới hơn 0.9)", () => {
    const sorted = ["1.0", "0.10", "0.9", "0.0", "2.0", "1.1"].sort(compareDocVersions)
    expect(sorted).toEqual(["0.0", "0.9", "0.10", "1.0", "1.1", "2.0"])
    expect(compareDocVersions("0.10", "0.9")).toBeGreaterThan(0)
  })

  it("release là x.0 với x ≥ 1; 0.0 (import) và x.y (y > 0) là draft", () => {
    expect(isReleaseVersion("1.0")).toBe(true)
    expect(isReleaseVersion("3.0")).toBe(true)
    expect(isReleaseVersion("0.0")).toBe(false)
    expect(isReleaseVersion("1.2")).toBe(false)
  })

  it("tên file tải về: draft có _DRAFT, release thì không; bỏ ký tự cấm của Windows", () => {
    expect(downloadFileName("Lumen SRS", "0.2")).toBe("Lumen SRS_v0.2_DRAFT.docx")
    expect(downloadFileName("Lumen SRS", "1.0")).toBe("Lumen SRS_v1.0.docx")
    expect(downloadFileName("A/B:C", "0.0")).toBe("A_B_C_v0.0_DRAFT.docx")
    expect(downloadFileName("   ", "1.0")).toBe("SRS_v1.0.docx")
  })

  it.each([
    ["0.99", "0.100"],
    ["99.99", "99.100"],
    ["10.0", "10.1"],
    ["0.9007199254740990", "0.9007199254740991"]
  ])("mốc biên nextMinor(%s) = %s (tăng số, không cộng chuỗi, không tràn sang major)", (current, expected) => {
    expect(nextMinor(current)).toBe(expected)
    expect(compareDocVersions(nextMinor(current), current)).toBeGreaterThan(0)
  })

  it.each([
    ["0.100", "1.0"],
    ["9.0", "10.0"],
    ["99.99", "100.0"]
  ])("mốc biên nextMajor(%s) = %s (luôn về minor 0, là bản release)", (current, expected) => {
    expect(nextMajor(current)).toBe(expected)
    expect(isReleaseVersion(nextMajor(current))).toBe(true)
  })

  it("chuỗi minor sau release: 0.0 → 0.1 → 1.0 → 1.1 → 2.0 sắp đúng thứ tự", () => {
    const chain = ["0.0"]
    const last = () => chain[chain.length - 1]
    chain.push(nextMinor(last()))
    chain.push(nextMajor(last()))
    chain.push(nextMinor(last()))
    chain.push(nextMajor(last()))
    expect(chain).toEqual(["0.0", "0.1", "1.0", "1.1", "2.0"])
    expect([...chain].reverse().sort(compareDocVersions)).toEqual(chain)
    expect(compareDocVersions("1.1", "1.1")).toBe(0)
  })

  it("đầu vào sai ⇒ nextMinor/nextMajor/compare/isRelease đều ném lỗi (không đoán)", () => {
    for (const bad of [" 1.0", "1.0 ", "-1.0", "1.-1", "1,0", "1..0", "a.b", "0.00"]) {
      expect(() => nextMinor(bad), bad).toThrow(/Version tài liệu không hợp lệ/)
      expect(() => nextMajor(bad), bad).toThrow(/Version tài liệu không hợp lệ/)
      expect(() => isReleaseVersion(bad), bad).toThrow()
    }
    expect(() => compareDocVersions("1.0", "x")).toThrow()
    expect(parseDocVersion("12.34")).toEqual({ major: 12, minor: 34 })
  })
})
