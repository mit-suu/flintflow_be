import { describe, expect, it } from "vitest"
import { headingOverlap, looksLikeSrs } from "./docx-precheck.js"

describe("looksLikeSrs", () => {
  it("dấu version FlintFlow hoặc Code nhận ra SRS / mẫu SRS ⇒ true; không phải SRS / chưa chắc ⇒ false", () => {
    const kind = (k: "srs" | "srs_template" | "not_srs" | "unknown") => ({ kind: k, confidence: 0.8, signals: [], reasons: [] })
    expect(looksLikeSrs({ stamp: { project_id: "p1" } as never, document_kind: null })).toBe(true)
    expect(looksLikeSrs({ stamp: null, document_kind: kind("srs") })).toBe(true)
    expect(looksLikeSrs({ stamp: null, document_kind: kind("srs_template") })).toBe(true)
    expect(looksLikeSrs({ stamp: null, document_kind: kind("not_srs") })).toBe(false)
    expect(looksLikeSrs({ stamp: null, document_kind: kind("unknown") })).toBe(false)
    expect(looksLikeSrs({ stamp: null, document_kind: null })).toBe(false)
  })
})

describe("headingOverlap", () => {
  it("tỉ lệ heading của file có trong SRS của dự án — bỏ số mục, không phân biệt hoa thường, đếm mỗi heading một lần", () => {
    const project = ["1 Product Overview", "2.1 Actors", "2.2 Use Cases", "3.1 Screen Flow"]
    expect(headingOverlap(["1. product overview", "2.1 Actors", "9 Budget", "9 Budget"], project)).toBe(0.67)
    expect(headingOverlap(["Meeting notes"], project)).toBe(0)
    expect(headingOverlap([], project)).toBe(0)
  })
})
