import { describe, it, expect } from "vitest"
import {
  compareDocVersions,
  isDocVersion,
  isReleaseVersion,
  nextMajor,
  nextMinor,
  parseDocVersion,
  versionFileName,
  versionLineage,
  type LineageVersion
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

  it("FLF-334 tên file: release / nháp có CR / nháp v0 / mode 2 chưa baseline / tracked / original / pdf", () => {
    expect(versionFileName({ name: "Lumen SRS", release: true, base: "2.0" })).toBe("Lumen SRS_v2.0.docx")
    expect(versionFileName({ name: "Lumen SRS", release: false, base: "1.0", latestCr: "CR-014" })).toBe("Lumen SRS_v1.0+CR-014_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: "0", latestCr: "CR-002" })).toBe("Lumen_v0+CR-002_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: "v0", latestCr: null })).toBe("Lumen_v0_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: "v1.0" })).toBe("Lumen_v1.0_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: null })).toBe("Lumen_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: "1.0", latestCr: "CR-001", tracked: true })).toBe("Lumen_v1.0+CR-001_tracked_DRAFT.docx")
    expect(versionFileName({ name: "Lumen", release: false, base: "0", original: true })).toBe("Lumen_v0_original.docx")
    expect(versionFileName({ name: "Lumen", release: true, base: "2.0", ext: "pdf" })).toBe("Lumen_v2.0.pdf")
    // release bỏ qua mã CR; không mang mã dự án
    expect(versionFileName({ name: "Lumen", release: true, base: "1.0", latestCr: "CR-009" })).toBe("Lumen_v1.0.docx")
  })

  it("tên file bỏ ký tự cấm của Windows, tên rỗng ⇒ SRS, giữ chữ Unicode", () => {
    expect(versionFileName({ name: "A/B:C", release: false, base: "0" })).toBe("A_B_C_v0_DRAFT.docx")
    expect(versionFileName({ name: "A\\B", release: true, base: "2.0" })).toBe("A_B_v2.0.docx")
    expect(versionFileName({ name: "   ", release: true, base: "1.0" })).toBe("SRS_v1.0.docx")
    expect(versionFileName({ name: "Dự án", release: true, base: "1.0" })).toBe("Dự án_v1.0.docx")
  })

  describe("versionLineage — release gốc + CR mới nhất theo version", () => {
    const v = (version: string, kind: string, cr_ids: string[] = []): LineageVersion => ({ version, kind, cr_ids })
    const history = [v("0.1", "imported"), v("0.2", "cr_revision", ["CR-001"]), v("1.0", "release", ["CR-001"]), v("1.1", "cr_revision", ["CR-002"]), v("1.2", "cr_revision", ["CR-003"])]

    it("release ⇒ chính nó, không CR", () => {
      expect(versionLineage(history, "1.0")).toEqual({ release: true, base: "1.0", latestCr: null })
    })

    it("nháp sau 2 CR từ 1.0 ⇒ base 1.0, CR của chính nó; bản nháp cũ hơn ⇒ CR của nó", () => {
      expect(versionLineage(history, "1.2")).toEqual({ release: false, base: "1.0", latestCr: "CR-003" })
      expect(versionLineage(history, "1.1")).toEqual({ release: false, base: "1.0", latestCr: "CR-002" })
    })

    it("trước release đầu ⇒ base 0; bản import ⇒ không CR (CR của release không lọt vào)", () => {
      expect(versionLineage(history, "0.2")).toEqual({ release: false, base: "0", latestCr: "CR-001" })
      expect(versionLineage(history, "0.1")).toEqual({ release: false, base: "0", latestCr: null })
      expect(versionLineage([v("0.0", "imported")], "0.0")).toEqual({ release: false, base: "0", latestCr: null })
    })

    it("release theo số, không theo kind: bản chuyển đổi 1.0 (kind imported) là gốc của 1.1", () => {
      expect(versionLineage([v("1.0", "imported"), v("1.1", "cr_revision", ["CR-001"])], "1.1")).toEqual({ release: false, base: "1.0", latestCr: "CR-001" })
    })

    it("CR cuối của version có nhiều CR", () => {
      expect(versionLineage([v("0.1", "imported"), v("0.2", "cr_revision", ["CR-004", "CR-005"])], "0.2").latestCr).toBe("CR-005")
    })
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
