import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { REQUIRED_FIXED_SECTION_IDS } from "../spine/section-registry.js"
import type { Spine } from "../spine/spine.types.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { compareTargetStructure } from "./target-structure.js"

const entry = (order: number, section_id: string, heading_text: string, level = 1): LayoutEntry => ({ order, section_id, heading_text, level })

const spineWith = (over: Partial<Spine> = {}): Spine => ({ ...createEmptySpine({ name: "Thư viện" }), ...over })

describe("compareTargetStructure (FLF-336 I-5 — so cấu trúc đích)", () => {
  it("ý định tự do, file thiếu mục ⇒ chế độ 4: mục FPT bắt buộc có chữ / dữ liệu là present, còn lại missing; mục riêng là out_of_scope", () => {
    const layout = [entry(0, "fixed:1", "1. Tổng quan"), entry(1, "fixed:3.1.1", "3.1.1 Luồng màn"), entry(2, "custom:CS01", "Phụ lục Dự toán")]
    const spine = spineWith({ screens: [{ id: "S01", feature_id: "F01", name: "Trang chủ", description: "", flow_to: [], is_popup: false } as never] })
    const result = compareTargetStructure(layout, new Set(["fixed:1"]), spine, "free", "2026-10-27T00:00:00.000Z")
    expect(result).toMatchObject({ target: "fpt", intent: "free", resolved_mode: 4, compared_at: "2026-10-27T00:00:00.000Z" })
    const byId = new Map(result.sections.map((s) => [s.section_id, s]))
    expect(byId.get("fixed:1")).toMatchObject({ status: "present", title: "1. Tổng quan" })
    expect(byId.get("fixed:2.1")?.status).toBe("missing")
    expect(byId.get("custom:CS01")).toMatchObject({ status: "out_of_scope", title: "Phụ lục Dự toán", owner_steps: [] })
    expect(result.missing).toContain("fixed:2.1")
    expect(result.missing).not.toContain("fixed:1")
    // Mỗi mục FPT bắt buộc xuất hiện đúng một lần, kèm bước sở hữu
    expect(result.sections.filter((s) => s.status !== "out_of_scope").map((s) => s.section_id)).toEqual([...REQUIRED_FIXED_SECTION_IDS])
    expect(byId.get("fixed:2.1")?.owner_steps.length).toBeGreaterThan(0)
  })

  it("FLF-362: tiêu đề mục (bước 3 \"Đọc file & tạo bản gốc\") kèm số Word tự đánh của file; chữ đã gõ số tay giữ nguyên", () => {
    const layout = [{ ...entry(0, "fixed:1", "Tổng quan"), number_label: "1." }, { ...entry(1, "fixed:2.1", "2.1 Tác nhân", 2), number_label: "9.9" }]
    const byId = new Map(compareTargetStructure(layout, new Set(["fixed:1"]), spineWith(), "free").sections.map((s) => [s.section_id, s.title]))
    expect(byId.get("fixed:1")).toBe("1. Tổng quan")
    expect(byId.get("fixed:2.1")).toBe("2.1 Tác nhân")
  })

  it("đủ cấu trúc đích ⇒ chế độ 1, không missing", () => {
    const layout = REQUIRED_FIXED_SECTION_IDS.map((id, i) => entry(i, id, id))
    const result = compareTargetStructure(layout, new Set(REQUIRED_FIXED_SECTION_IDS), spineWith(), "free")
    expect(result.resolved_mode).toBe(1)
    expect(result.missing).toEqual([])
  })

  it("ý định theo mẫu cố định: đích là chính heading của file; heading trống ⇒ missing ⇒ chế độ 3; không có out_of_scope, không thêm mục FPT thiếu", () => {
    const layout = [entry(0, "group:2", "Chương 2", 1), entry(1, "fixed:1", "Chương 1 Giới thiệu", 1), entry(2, "custom:CS02", "Chương 3 Dự toán", 1), entry(3, "fixed:2.1", "2.1 Tác nhân", 2)]
    const result = compareTargetStructure(layout, new Set(["fixed:1", "custom:CS02"]), spineWith(), "fixed")
    expect(result).toMatchObject({ target: "template", resolved_mode: 3, missing: ["fixed:2.1"] })
    expect(result.sections.map((s) => [s.section_id, s.status])).toEqual([
      ["fixed:1", "present"],
      ["custom:CS02", "present"],
      ["fixed:2.1", "missing"]
    ])
    expect(result.sections.some((s) => s.section_id === "fixed:5.1")).toBe(false)
  })

  it("mẫu cố định: phần nối (mục riêng tiêu đề rỗng dưới heading nhóm / khối không trích) không phải mục của mẫu ⇒ không thành dòng riêng", () => {
    const layout = [entry(0, "fixed:1", "Product Overview", 1), entry(1, "group:3.1", "Product Vision", 2), entry(2, "custom:CS01", "", 3), entry(3, "custom:CS02", "Known Risks", 2)]
    const result = compareTargetStructure(layout, new Set(), spineWith(), "fixed")
    expect(result.sections.map((s) => s.section_id)).toEqual(["fixed:1", "custom:CS02"])
    expect(result.missing).toEqual(["fixed:1", "custom:CS02"])
  })

  it("mẫu cố định: heading bao (mục riêng chỉ chứa mục con) trống không phải mục cần soạn; có chữ thật thì vẫn là mục", () => {
    const layout = [entry(0, "custom:CS01", "2 Overall Description", 1), entry(1, "fixed:2.1", "2.1 User Classes", 2), entry(2, "custom:CS02", "3 Notes", 1), entry(3, "custom:CS03", "3.1 Open Issues", 2)]
    const result = compareTargetStructure(layout, new Set(["custom:CS02"]), spineWith(), "fixed")
    expect(result.sections.map((s) => [s.section_id, s.status])).toEqual([
      ["fixed:2.1", "missing"],
      ["custom:CS02", "present"],
      ["custom:CS03", "missing"]
    ])
  })

  it("FLF-379: mẫu cố định — heading chỉ có mục con (tính năng ⇒ chức năng) có nội dung ⇒ present; mục con trống hết ⇒ missing", () => {
    const layout = [
      entry(0, "feature:F-3.2", "3.2 Course Registration", 2),
      entry(1, "function:FR-3.2.1", "3.2.1 Register for course sections", 3),
      entry(2, "feature:F-3.3", "3.3 Attendance", 2),
      entry(3, "function:FR-3.3.1", "3.3.1 Take attendance", 3),
      entry(4, "fixed:4.2.3", "4 Performance", 2)
    ]
    const result = compareTargetStructure(layout, new Set(["function:FR-3.2.1"]), spineWith(), "fixed")
    expect(result.sections.map((s) => [s.section_id, s.status])).toEqual([
      ["feature:F-3.2", "present"],
      ["function:FR-3.2.1", "present"],
      ["feature:F-3.3", "missing"],
      ["function:FR-3.3.1", "missing"],
      ["fixed:4.2.3", "missing"]
    ])
  })

  it("FLF-379: mẫu cố định — Record of Changes / Revision History tự sinh, không thành mục \"Sẽ soạn\"", () => {
    const layout = [entry(0, "fixed:I", "Revision History", 1), entry(1, "fixed:1", "Introduction", 1)]
    const result = compareTargetStructure(layout, new Set(["fixed:1"]), spineWith(), "fixed")
    expect(result.sections.map((s) => s.section_id)).toEqual(["fixed:1"])
    expect(result.resolved_mode).toBe(1)
  })
})
