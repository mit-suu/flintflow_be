/**
 * review.service.ts — phần hàm thuần (FLF-453, business-flow §3.1.2 "Rà soát phần có sẵn"). Luồng thật (AI giả + recompute
 * trên Mongo, 4 nhánh của finalize.service.ts) ở `test/integration/mode1/review.service.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Flag } from "../spine/spine.types.js"
import { redFlaggedPresentSections, reviewInputSections, sectionsNeedingAiReview } from "./review.service.js"
import type { TargetSection } from "./target-structure.js"

const section = (section_id: string, status: TargetSection["status"]): TargetSection => ({ section_id, title: section_id, status, owner_steps: [] })

const flag = (overrides: Partial<Flag>): Flag => ({
  id: "FL001",
  level: "yellow",
  rule_id: "section_empty",
  section_id: "fixed:1",
  message: "x",
  remediation_step: "S-2",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...overrides
})

describe("reviewInputSections", () => {
  it("không mục nào thiếu ⇒ không mục nào cần rà vì đầu vào", () => {
    const sections = [section("fixed:1", "present"), section("function:FN01", "present")]
    expect(reviewInputSections({ sections, missing: [] })).toEqual([])
  })

  it("mục có sẵn khớp owner của bảng §4 mà reads trỏ tới mục thiếu ⇒ là đầu vào (vd function ⇒ Use Case Descriptions)", () => {
    const sections = [section("function:FN01", "present"), section("fixed:2.2.2", "missing")]
    const got = reviewInputSections({ sections, missing: ["fixed:2.2.2"] })
    expect(got).toContain("function:FN01")
  })

  it("Product Overview (fixed:1) có sẵn ⇒ luôn là đầu vào khi còn mục thiếu (Brief luôn mở lại sang Luồng 2)", () => {
    const sections = [section("fixed:1", "present"), section("fixed:3.1.4", "missing")]
    expect(reviewInputSections({ sections, missing: ["fixed:3.1.4"] })).toEqual(["fixed:1"])
  })

  it("mục có sẵn không khớp owner nào trỏ tới mục thiếu ⇒ không phải đầu vào", () => {
    const sections = [section("fixed:5.5", "present"), section("fixed:3.1.4", "missing")]
    expect(reviewInputSections({ sections, missing: ["fixed:3.1.4"] })).toEqual([])
  })
})

describe("reviewInputSections - cột derived và khuôn", () => {
  it("thiếu 2.2.1 Use Case Diagram ⇒ 2.2.2 (use_cases, derived diagram:usecase) là đầu vào", () => {
    const sections = [section("fixed:2.2.2", "present"), section("fixed:2.2.1", "missing")]
    expect(reviewInputSections({ sections, missing: ["fixed:2.2.1"] })).toContain("fixed:2.2.2")
  })

  it("thiếu 5.3 Messages ⇒ mục chức năng (functions_abnormal, derived fixed:5.3) là đầu vào", () => {
    const sections = [section("function:FN01", "present"), section("fixed:5.3", "missing")]
    expect(reviewInputSections({ sections, missing: ["fixed:5.3"] })).toContain("function:FN01")
  })

  it("thiếu một mục chức năng ⇒ khuôn function:<screen> / function:<rule> khớp: mục 3.1.2 và 5.1 là đầu vào", () => {
    const sections = [section("fixed:3.1.2", "present"), section("fixed:5.1", "present"), section("function:FN02", "missing")]
    const got = reviewInputSections({ sections, missing: ["function:FN02"] })
    expect(got).toEqual(expect.arrayContaining(["fixed:3.1.2", "fixed:5.1"]))
  })
})

describe("redFlaggedPresentSections", () => {
  const sections = [section("fixed:1", "present"), section("fixed:3.1.2", "missing")]

  it("cờ đỏ chưa gỡ trên mục có sẵn ⇒ cần rà", () => {
    const flags = [flag({ level: "red", section_id: "fixed:1" })]
    expect(redFlaggedPresentSections({ sections }, flags)).toEqual(["fixed:1"])
  })

  it("cờ vàng không tính dù trên mục có sẵn", () => {
    const flags = [flag({ level: "yellow", section_id: "fixed:1" })]
    expect(redFlaggedPresentSections({ sections }, flags)).toEqual([])
  })

  it("cờ đỏ đã gỡ (resolved_at) không tính", () => {
    const flags = [flag({ level: "red", section_id: "fixed:1", resolved_at: "2026-01-01T00:00:00.000Z" })]
    expect(redFlaggedPresentSections({ sections }, flags)).toEqual([])
  })

  it("cờ đỏ trên mục còn thiếu không tính (chỉ xét mục có sẵn)", () => {
    const flags = [flag({ level: "red", section_id: "fixed:3.1.2" })]
    expect(redFlaggedPresentSections({ sections }, flags)).toEqual([])
  })

  it("không trùng khi nhiều cờ đỏ cùng một mục", () => {
    const flags = [flag({ id: "FL001", level: "red", section_id: "fixed:1" }), flag({ id: "FL002", level: "red", section_id: "fixed:1" })]
    expect(redFlaggedPresentSections({ sections }, flags)).toEqual(["fixed:1"])
  })
})

describe("sectionsNeedingAiReview — hàm chọn mục cần rà (business-flow §3.1.2)", () => {
  it("không mục nào cần rà (file chỉ có heading, không cờ đỏ, không mục đầu vào) ⇒ rỗng, bỏ qua vòng rà soát", () => {
    const sections = [section("fixed:3.1.4", "missing")]
    expect(sectionsNeedingAiReview({ sections, missing: ["fixed:3.1.4"] }, [])).toEqual([])
  })

  it("hợp hai nhóm: mục đầu vào của phần thiếu + mục cờ đỏ, không trùng", () => {
    const sections = [section("fixed:1", "present"), section("function:FN01", "present"), section("fixed:5.5", "present"), section("fixed:2.2.2", "missing")]
    const flags = [flag({ level: "red", section_id: "fixed:5.5" }), flag({ level: "red", section_id: "fixed:1" })]
    const got = sectionsNeedingAiReview({ sections, missing: ["fixed:2.2.2"] }, flags)
    expect(new Set(got)).toEqual(new Set(["fixed:1", "function:FN01", "fixed:5.5"]))
  })
})
