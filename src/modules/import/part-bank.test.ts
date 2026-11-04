import { describe, expect, it } from "vitest"
import { PART_BANK, isWeakTitle, partById } from "./part-bank.js"
import { isKnownSectionId } from "./section-catalog.js"

const norm = (t: string) => t.trim().toLowerCase()

describe("PART_BANK (FLF-363)", () => {
  it("mỗi phần có id duy nhất, đích hợp lệ và ít nhất một tên", () => {
    const ids = PART_BANK.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PART_BANK) {
      expect(p.titles.length, p.id).toBeGreaterThan(0)
      expect(p.target === "keep" || p.target === "parent" || p.target === "feature" || isKnownSectionId(p.target), `${p.id} → ${p.target}`).toBe(true)
    }
  })

  it("tên không chứa số mục", () => {
    for (const p of PART_BANK) for (const t of p.titles) expect(t.text, p.id).not.toMatch(/^\s*(\d+(\.\d+)*|[IVX]+)[.)]?\s/)
  })

  it("không trùng tên giữa hai phần, trừ phần phân biệt bằng mục cha", () => {
    const owner = new Map<string, string>()
    for (const p of PART_BANK) {
      if (p.parents || p.underFeature) continue
      for (const t of p.titles) {
        const k = norm(t.text)
        expect(owner.get(k), `"${t.text}" ở ${owner.get(k)} và ${p.id}`).toBeUndefined()
        owner.set(k, p.id)
      }
    }
  })

  it("mục cha khai báo là phần có trong ngân hàng", () => {
    for (const p of PART_BANK) for (const parent of p.parents ?? []) expect(partById(parent), `${p.id} › ${parent}`).toBeDefined()
  })

  it("giữ mọi section FPT và gộp tên IEEE vào đúng phần", () => {
    expect(partById("part:fixed:4.2.2")?.titles.map((t) => t.text)).toEqual(expect.arrayContaining(["Reliability", "Availability"]))
    expect(partById("part:fixed:2.2.1")?.titles.map((t) => t.text)).toContain("Product Functions")
    expect(partById("part:group:3.1")?.titles.map((t) => t.text)).not.toContain("Product Functions")
    expect(partById("part:ieee:references")?.target).toBe("slot:references")
    expect(partById("part:group:3")?.features).toBe(true)
    expect(partById("part:ieee:feature_detail")?.underFeature).toBe(true)
  })

  it("tên chung chung là tên yếu", () => {
    expect(isWeakTitle("Requirements")).toBe(true)
    expect(isWeakTitle(" cost ")).toBe(true)
    expect(isWeakTitle("Software Requirements Specification")).toBe(false)
  })
})
