import { describe, expect, it } from "vitest"
import { nextStep } from "../pipeline/step-registry.js"
import { progressByStep } from "../spine/section-status.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine, StepState } from "../spine/spine.types.js"
import { buildLayout, buildStepPlan, continuationOwnerSection, customSectionOps, sectionsOwnedBy, sectionsWithContent, seedStepOps, type LayoutBlock } from "./step-plan.js"

const h = (block_id: string, text: string, level: number, section_id: string | null = null): LayoutBlock => ({ block_id, kind: "heading", level, text, section_id })
const p = (block_id: string, text: string, section_id: string | null): LayoutBlock => ({ block_id, kind: "paragraph", level: null, text, section_id })

/** File kiểu IEEE rút gọn: 1 Introduction (fixed:1) › 1.1 Purpose (con cùng section) · 1.4 References (unmapped) · 2 Actors · Phụ lục. */
const BLOCKS: LayoutBlock[] = [
  h("B0001", "1 Introduction", 1, "fixed:1"),
  p("B0002", "Lumen is a learning platform.", "fixed:1"),
  h("B0003", "1.1 Purpose", 2, "fixed:1"),
  p("B0004", "Purpose text.", "fixed:1"),
  h("B0005", "1.4 References", 2),
  p("B0006", "IEEE 830-1998", null),
  { block_id: "B0007", kind: "table", level: null, text: "Doc | Link\nSRS | x", section_id: null, rows: [["Doc", "Link"], ["SRS", "x"]] },
  { block_id: "B0008", kind: "table_cell", level: null, text: "Doc", section_id: null },
  h("B0009", "2 Actors", 1, "fixed:2.1"),
  h("B0010", "5.1 Business Rules", 2, "fixed:5.1"),
  h("B0011", "Appendix A — Meeting notes", 1),
  { block_id: "B0012", kind: "list_item", level: null, text: "Kick-off 12/09", section_id: null },
  { block_id: "B0013", kind: "image", level: null, text: "", section_id: null },
  p("B0014", "   ", null),
  h("B0015", "1.2 Scope", 2, "fixed:1")
]
const HEADINGS = new Map([
  ["B0001", "fixed:1"],
  ["B0003", "fixed:1"],
  ["B0005", "unmapped"],
  ["B0009", "fixed:2.1"],
  ["B0010", "fixed:5.1"],
  ["B0011", "unmapped"],
  ["B0015", "fixed:1"]
])

describe("buildLayout", () => {
  it("heading mở section FPT giữ section; heading con cùng section bỏ; unmapped ⇒ mục riêng giữ nguyên văn; section FPT lặp ở chỗ khác ⇒ mục riêng", () => {
    const { layout, customSections } = buildLayout(BLOCKS, HEADINGS)
    expect(layout.map((l) => [l.heading_text, l.level, l.section_id])).toEqual([
      ["1 Introduction", 1, "fixed:1"],
      ["1.4 References", 2, "custom:CS01"],
      ["2 Actors", 1, "fixed:2.1"],
      ["5.1 Business Rules", 2, "fixed:5.1"],
      ["Appendix A — Meeting notes", 1, "custom:CS02"],
      ["1.2 Scope", 2, "custom:CS03"]
    ])
    expect(layout.map((l) => l.order)).toEqual([0, 1, 2, 3, 4, 5])
    expect(customSections[0]).toEqual({
      id: "CS01",
      heading: "1.4 References",
      level: 2,
      source: "import",
      blocks: [
        { kind: "paragraph", text: "IEEE 830-1998", rows: null, image_ref: null },
        { kind: "table", text: "", rows: [["Doc", "Link"], ["SRS", "x"]], image_ref: null }
      ]
    })
    // khối rỗng bỏ, ô bảng không lặp, ảnh giữ chỗ
    expect(customSections[1].blocks.map((b) => b.kind)).toEqual(["list_item", "image"])
    expect(customSectionOps(customSections).map((o) => o.path)).toEqual(["custom_sections[]", "custom_sections[]", "custom_sections[]"])
  })

  it("không có heading ⇒ layout rỗng; block trước heading đầu tiên không vào mục riêng", () => {
    expect(buildLayout([p("B0001", "Cover page", null)], new Map())).toEqual({ layout: [], customSections: [] })
  })

  it("FLF-184: văn xuôi I-4 không trích được ⇒ phần nối (tiêu đề rỗng, cấp + 1) ngay sau section; khối dưới heading con cùng section gom vào cùng phần nối", () => {
    const { layout, customSections } = buildLayout(BLOCKS, HEADINGS, new Set(["B0002", "B0004"]))
    expect(layout.slice(0, 3).map((l) => [l.heading_text, l.level, l.section_id])).toEqual([
      ["1 Introduction", 1, "fixed:1"],
      ["", 2, "custom:CS01"],
      ["1.4 References", 2, "custom:CS02"]
    ])
    expect(customSections[0]).toMatchObject({ heading: "", level: 2, blocks: [{ text: "Lumen is a learning platform." }, { text: "Purpose text." }] })
    // nợ T5: tra ngược được mục chủ của phần nối — đúng mục mà assemble gộp nội dung vào
    expect(continuationOwnerSection(layout, "custom:CS01")).toBe("fixed:1")
    expect(continuationOwnerSection(layout, "custom:CS02")).toBe("fixed:1") // mục riêng thường: mục bao nó
    expect(continuationOwnerSection(layout, "custom:CS99")).toBeNull()
  })

  it("FLF-184: khối dưới heading nhóm luôn giữ (nhóm không trích); nội dung sau heading con cùng section về section đó, không dồn vào mục riêng đứng trước", () => {
    const blocks: LayoutBlock[] = [
      h("B0001", "2 User Requirements", 1, "group:2"),
      p("B0002", "This chapter lists who uses Lumen.", null),
      h("B0003", "2.1 Actors", 2, "fixed:2.1"),
      h("B0004", "2.1.9 Notes", 3),
      p("B0005", "Draft note", null),
      h("B0006", "2.1.10 More actors", 3, "fixed:2.1"),
      p("B0007", "Guests are read-only.", "fixed:2.1"),
      p("B0008", "Extracted row", "fixed:2.1")
    ]
    const headings = new Map([
      ["B0001", "group:2"],
      ["B0003", "fixed:2.1"],
      ["B0004", "unmapped"],
      ["B0006", "fixed:2.1"]
    ])
    const { layout, customSections } = buildLayout(blocks, headings, new Set(["B0007"]))
    expect(layout.map((l) => [l.heading_text, l.level, l.section_id])).toEqual([
      ["2 User Requirements", 1, "group:2"],
      ["", 2, "custom:CS01"],
      ["2.1 Actors", 2, "fixed:2.1"],
      ["2.1.9 Notes", 3, "custom:CS02"],
      ["", 3, "custom:CS03"]
    ])
    expect(customSections.map((c) => c.blocks.map((b) => b.text))).toEqual([["This chapter lists who uses Lumen."], ["Draft note"], ["Guests are read-only."]])
  })
})

describe("sectionsWithContent", () => {
  it("chỉ section có khối không phải heading; mục chỉ có heading coi như trống", () => {
    expect(sectionsWithContent(BLOCKS)).toEqual(new Set(["fixed:1"]))
  })
})

describe("buildStepPlan (D6 — mọi đầu mục FPT là cốt lõi)", () => {
  const { layout } = buildLayout(BLOCKS, HEADINGS)
  const plan = buildStepPlan(layout, sectionsWithContent(BLOCKS))
  const of = (id: string) => plan.find((s) => s.step_id === id)!

  it("Brief và S-1 ẩn; step đầu mục FPT luôn applied; không có vòng S-5", () => {
    expect(of("B-0.1")).toMatchObject({ state: "hidden", missing: false })
    expect(of("S-1.3")).toMatchObject({ state: "hidden" })
    expect(plan.filter((s) => s.state !== "hidden").every((s) => s.state === "applied")).toBe(true)
    expect(plan.some((s) => s.step_id.startsWith("S-5."))).toBe(false)
  })

  it("có nội dung ⇒ không thiếu; có heading nhưng trống / file không có ⇒ missing kèm lý do", () => {
    expect(of("S-2.1")).toMatchObject({ missing: false, section_ids: ["fixed:1"], reason: "Có trong file, đã có nội dung" })
    expect(of("S-7.1")).toMatchObject({ missing: true, reason: "Đầu mục mẫu FPT có trong file nhưng trống" })
    expect(of("S-6.4")).toMatchObject({ missing: true, section_ids: ["fixed:4.2.3"], reason: "Đầu mục mẫu FPT — file không có" })
    expect(of("S-4.1").section_ids).toEqual(["fixed:3.1.2", "feature:*"])
  })

  it("Record of Changes tự sinh — không thiếu; bước ghép / kiểm tra luôn chạy", () => {
    expect(of("S-8.3")).toMatchObject({ state: "applied", missing: false, reason: "Mục tự sinh từ lịch sử thay đổi" })
    expect(of("S-8.4")).toMatchObject({ state: "applied", missing: false, section_ids: [] })
    expect(of("S-9.5")).toMatchObject({ state: "applied", missing: false })
  })

  it("sectionsOwnedBy theo bảng step sở hữu", () => {
    expect(sectionsOwnedBy("S-3.6")).toEqual(["fixed:2.2.1"])
    expect(sectionsOwnedBy("S-9.1")).toEqual([])
  })
})

describe("seedStepOps + step engine với step skipped", () => {
  const spineWith = (): Spine => {
    const s = createEmptySpine({ name: "Lumen" })
    s.features = [{ id: "F-01", name: "Auth", order: 0 }] as Spine["features"]
    s.screens = [
      { id: "SCR-01", feature_id: "F-01", name: "Login", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: null, detail_status: "signed_off" },
      { id: "SCR-02", feature_id: "F-01", name: "Empty", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: null, detail_status: "placeholder" }
    ] as Spine["screens"]
    s.functions = [{ id: "FR-01", screen_id: "SCR-01", feature_id: "F-01", order: 0, name: "Log in" }] as unknown as Spine["functions"]
    return s
  }
  const { layout } = buildLayout(BLOCKS, HEADINGS)
  const plan = buildStepPlan(layout, sectionsWithContent(BLOCKS))

  it("ẩn ⇒ skipped; có nội dung ⇒ accepted (last_seq của lô import); thiếu ⇒ pending; vòng S-5 của màn có function ⇒ accepted", () => {
    const ops = seedStepOps(spineWith(), plan, { firstSeq: 3, lastSeq: 40, at: "2026-09-19T08:00:00.000Z" })
    const steps = ops.filter((o) => o.path === "steps[]").map((o) => o.value as StepState)
    const st = (id: string) => steps.find((s) => s.id === id)
    expect(st("B-0.1")?.status).toBe("skipped")
    expect(st("S-2.1")).toEqual({ id: "S-2.1", status: "accepted", first_seq: 3, last_seq: 40, accepted_at: "2026-09-19T08:00:00.000Z" })
    expect(st("S-7.1")).toMatchObject({ status: "pending", first_seq: null })
    expect(["S-5.1", "S-5.2", "S-5.3", "S-5.4", "S-5.5"].map((t) => st(`${t}@SCR-01`)?.status)).toEqual(Array(5).fill("accepted"))
    expect(st("S-5.1@SCR-02")).toBeUndefined()
    // bước kế tiếp: step pending đầu tiên theo thứ tự registry (bỏ Brief skipped)
    const current = ops.find((o) => o.path === "progress.current_step")!.value as string
    expect(st(current)?.status).toBe("pending")
    expect(current.startsWith("B-") || current.startsWith("S-1.")).toBe(false)
  })

  it("nextStep bỏ step skipped; tổng tiến độ trừ step skipped", () => {
    const s = spineWith()
    const ops = seedStepOps(s, plan, { firstSeq: 1, lastSeq: 1, at: "2026-09-19T08:00:00.000Z" })
    s.steps = ops.filter((o) => o.path === "steps[]").map((o) => o.value as StepState)
    const next = nextStep(s)
    expect(next?.id).toBe(ops.find((o) => o.path === "progress.current_step")!.value)
    const skipped = s.steps.filter((x) => x.status === "skipped").length
    expect(skipped).toBe(plan.filter((x) => x.state === "hidden").length)
    const withoutSkip = progressByStep({ ...s, steps: s.steps.filter((x) => x.status !== "skipped") })
    expect(progressByStep(s).total).toBe(withoutSkip.total - skipped)
  })
})
