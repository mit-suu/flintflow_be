/**
 * FLF-366 — in theo từng đoạn của file import: bản 0.1 khớp file (chữ, ảnh, thứ tự), CR chỉ đổi đoạn bị sửa. Hàm thuần.
 * Đi trọn đường thuần: block của file ⇒ `buildLayout` (chia đoạn) ⇒ `sectionSegments` (phần tử + dấu) ⇒ `buildLayoutSections`.
 */
import { describe, expect, it } from "vitest"
import { buildLayout, projectFieldEntities, sectionSegments, type LayoutBlock } from "../import/step-plan.js"
import { originalDiagramHash } from "../spine/original-diagram.js"
import { rehashSegments } from "../spine/segment-hash.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { buildLayoutSections, type TemplateLayout } from "./layout-sections.js"
import type { Block, RenderedSection } from "./rendered-document.types.js"

const h = (block_id: string, text: string, level: number, section_id: string): LayoutBlock => ({ block_id, kind: "heading", level, text, section_id })
const p = (block_id: string, text: string, section_id: string): LayoutBlock => ({ block_id, kind: "paragraph", level: null, text, section_id })
const table = (block_id: string, rows: string[][], section_id: string): LayoutBlock => ({ block_id, kind: "table", level: null, text: "", section_id, rows })

/** File kiểu FAP: mục 1 có đoạn mô tả, heading con "External Systems", danh sách, hình ngữ cảnh; 2.2 bảng use case; 5.1 văn xuôi + 2 bảng BR. */
const BLOCKS: LayoutBlock[] = [
  h("B01", "1 Product Overview", 1, "fixed:1"),
  p("B02", "FAP manages attendance for FPT University.", "fixed:1"),
  h("B03", "1.1 External Systems", 2, "fixed:1"),
  { block_id: "B04", kind: "list_item", level: null, text: "Email Service: sends notifications", section_id: "fixed:1" },
  { block_id: "B05", kind: "image", level: null, text: "Figure 1 Context", section_id: "fixed:1", image_ref: "word/media/image1.png" },
  h("B06", "2 Use Cases", 1, "fixed:2.2.2"),
  table("B07", [["ID", "Use Case", "Actor"], ["UC-01", "Take attendance", "Student"]], "fixed:2.2.2"),
  h("B08", "5.1 Business Rules", 1, "fixed:5.1"),
  p("B09", "Rules below apply to Student and Lecturer.", "fixed:5.1"),
  table("B10", [["ID", "Rule"], ["BR-01", "One check-in per slot"], ["BR-02", "Late after 15 minutes"]], "fixed:5.1"),
  table("B11", [["ID", "Rule"], ["BR-03", "Absent over 20% fails"]], "fixed:5.1")
]
const HEADINGS = new Map([
  ["B01", "fixed:1"],
  ["B03", "fixed:1"],
  ["B06", "fixed:2.2.2"],
  ["B08", "fixed:5.1"]
])
const UNMAPPED = new Set(["B04", "B05", "B09"])

const baseSpine = (): Spine => {
  const empty = createEmptySpine({ name: "FAP" })
  return {
    ...empty,
    project: { ...empty.project, vision: "FAP manages attendance." },
    actors: [
      { id: "A01", name: "Student", kind: "human", description: "Learner." },
      { id: "A02", name: "Email Service", kind: "system", description: "Mail gateway." },
      { id: "A03", name: "Lecturer", kind: "human", description: "Teacher." }
    ],
    use_cases: [{ id: "UC-01", name: "Take attendance", actor_ids: ["A01"], description: "Check in.", includes: [], extends: [], function_ids: [] }],
    business_rules: [
      { id: "BR-01", tier: "detail", statement: "One check-in per slot", source_validation_ids: [] },
      { id: "BR-02", tier: "detail", statement: "Late after 15 minutes", source_validation_ids: [] },
      { id: "BR-03", tier: "detail", statement: "Absent over 20% fails", source_validation_ids: [] }
    ],
    diagrams: [
      { id: "D01", kind: "context", format: "puml", source: "@startuml\n@enduml", section: "fixed:1", owner_kind: null, owner_id: null, render_status: "ok", source_hash: "h", rendered_at: null }
    ]
  } as Spine
}

/** Import: Spine sau lô thực thể + layout + đoạn (như finalize). */
const imported = () => {
  const spine = baseSpine()
  const blocks = BLOCKS.map((b) => (b.block_id === "B05" ? { ...b, diagram: { kind: "context" as const, source_hash: originalDiagramHash(spine, "context") } } : b))
  const { layout, customSections, segments } = buildLayout(blocks, HEADINGS, UNMAPPED)
  const entities = [
    { entity: "use_cases", id: "UC-01", source_block_ids: ["B07"] },
    { entity: "business_rules", id: "BR-01", source_block_ids: ["B10"] },
    { entity: "business_rules", id: "BR-02", source_block_ids: ["B10"] },
    { entity: "business_rules", id: "BR-03", source_block_ids: ["B11"] },
    ...projectFieldEntities([{ path: "project.vision", source_block_ids: ["B02"] }])
  ]
  const names = [
    { entity: "actor" as const, id: "A01", name: "Student" },
    { entity: "actor" as const, id: "A03", name: "Lecturer" }
  ]
  const records = sectionSegments(segments, customSections, entities, spine, names)
  const withCustom: Spine = { ...spine, custom_sections: customSections }
  const template: TemplateLayout = { layout, language: "en", sectionSegments: records }
  return { spine: withCustom, template, records }
}

const render = (spine: Spine, template: TemplateLayout): RenderedSection[] => buildLayoutSections(spine, template, [], { diagramPng: (id) => `png:${id}` }).sections
const section = (sections: RenderedSection[], id: string): RenderedSection => sections.find((s) => s.id === id)!

const textOf = (b: Block): string => {
  switch (b.type) {
    case "paragraph":
      return b.runs.map((r) => r.text).join("")
    case "bullet_list":
    case "numbered_list":
      return b.items.map((i) => i.map((r) => r.text).join("")).join(" | ")
    case "table":
      return [b.header, ...b.rows].map((r) => r.map((c) => c.map((x) => x.text).join("")).join(",")).join(" / ")
    case "image":
      return `[image ${b.png}]`
    case "heading":
      return `# ${b.text}`
    default:
      return b.type
  }
}
const texts = (s: RenderedSection): string[] => s.blocks.map(textOf)

describe("FLF-366 — bản 0.1 theo đoạn của file", () => {
  it("mỗi mục in đúng chữ, ảnh, thứ tự file: không gộp phần nối lên đầu, không in thêm External Systems / sơ đồ PlantUML", () => {
    const { spine, template } = imported()
    const sections = render(spine, template)
    expect(texts(section(sections, "fixed:1"))).toEqual([
      "FAP manages attendance for FPT University.",
      "1.1 External Systems",
      "Email Service: sends notifications",
      "[image png:media:word/media/image1.png]"
    ])
    expect(texts(section(sections, "fixed:2.2.2"))).toEqual(["ID,Use Case,Actor / UC-01,Take attendance,Student"])
    expect(texts(section(sections, "fixed:5.1"))).toEqual([
      "Rules below apply to Student and Lecturer.",
      "ID,Rule / BR-01,One check-in per slot / BR-02,Late after 15 minutes",
      "ID,Rule / BR-03,Absent over 20% fails"
    ])
    // phần nối đã in tại chỗ trong mục ⇒ không thành mục riêng
    expect(sections.some((s) => s.id.startsWith("custom:"))).toBe(false)
  })

  it("CR sửa 1 BR: chỉ bảng chứa BR đó dựng lại từ Spine đúng chỗ; phần còn lại giống bản trước", () => {
    const { spine, template } = imported()
    const before = render(spine, template)
    const after = render({ ...spine, business_rules: spine.business_rules.map((r) => (r.id === "BR-03" ? { ...r, statement: "Absent over 30% fails" } : r)) }, template)
    expect(texts(section(after, "fixed:5.1"))).toEqual([
      "Rules below apply to Student and Lecturer.",
      "ID,Rule / BR-01,One check-in per slot / BR-02,Late after 15 minutes",
      "Absent over 30% fails"
    ])
    for (const id of ["fixed:1", "fixed:2.2.2"]) expect(section(after, id)).toEqual(section(before, id))
  })

  it("CR đổi tên actor: đoạn in tên actor (bảng use case, qua tham chiếu) dựng lại; đoạn khác giữ nguyên", () => {
    const { spine, template } = imported()
    const before = render(spine, template)
    const after = render({ ...spine, actors: spine.actors.map((a) => (a.id === "A01" ? { ...a, name: "Learner" } : a)) }, template)
    expect(textOf(section(after, "fixed:2.2.2").blocks[0])).toContain("Learner")
    expect(section(after, "fixed:5.1")).toEqual(section(before, "fixed:5.1"))
    expect(section(after, "fixed:1")).toEqual(section(before, "fixed:1"))
  })

  it("phần tử CR thêm (không thuộc đoạn nào) in ở cuối mục; xoá phần tử ⇒ chỉ bảng của nó dựng lại", () => {
    const { spine, template } = imported()
    const added = render({ ...spine, business_rules: [...spine.business_rules, { id: "BR-04", tier: "detail", statement: "Excuse needs proof", source_validation_ids: [] }] }, template)
    const s51 = texts(section(added, "fixed:5.1"))
    expect(s51.slice(0, 3)).toEqual(texts(section(render(spine, template), "fixed:5.1")))
    expect(s51[3]).toBe("Excuse needs proof")
    const removed = render({ ...spine, business_rules: spine.business_rules.filter((r) => r.id !== "BR-02") }, template)
    expect(texts(section(removed, "fixed:5.1"))).toEqual(["Rules below apply to Student and Lecturer.", "One check-in per slot", "ID,Rule / BR-03,Absent over 20% fails"])
  })

  it("§4.13: CR bỏ ảnh sơ đồ gốc (vẽ lại) ⇒ sơ đồ FlintFlow cùng loại in ngay chỗ ảnh, không in lần nữa ở chỗ khác", () => {
    const { spine, template } = imported()
    const redrawn: Spine = {
      ...spine,
      custom_sections: spine.custom_sections.map((c) => ({ ...c, blocks: c.blocks.filter((b) => b.kind !== "image") }))
    }
    const sections = render(redrawn, template)
    expect(texts(section(sections, "fixed:1"))).toEqual(["FAP manages attendance for FPT University.", "1.1 External Systems", "Email Service: sends notifications", "[image png:D01]"])
    expect(sections.flatMap((s) => s.blocks).filter((b) => b.type === "image" && b.png === "png:D01")).toHaveLength(1)
  })

  it("lô ghi `by: import` (FLF-360) ⇒ tính lại dấu đoạn chứa phần tử vừa ghi: in nguyên văn như cũ, không thêm cuối mục", () => {
    const { spine, template, records } = imported()
    const reread: Spine = {
      ...spine,
      business_rules: [...spine.business_rules.map((r) => (r.id === "BR-01" ? { ...r, statement: "One check-in per slot." } : r)), { id: "BR-05", tier: "detail", statement: "Read from image", source_validation_ids: [] }]
    }
    const stale = texts(section(render(reread, template), "fixed:5.1"))
    expect(stale).not.toEqual(texts(section(render(spine, template), "fixed:5.1")))
    const fresh = rehashSegments(records, reread, new Set(["business_rules:BR-01", "business_rules:BR-05"]))
    expect(texts(section(render(reread, { ...template, sectionSegments: fresh }), "fixed:5.1"))).toEqual(texts(section(render(spine, template), "fixed:5.1")))
  })

  it("project cũ chưa có dữ liệu đoạn ⇒ in như trước (phần nối gộp lên đầu mục, mục render từ Spine)", () => {
    const { spine, template } = imported()
    const { sectionSegments: _drop, ...legacy } = template
    const s1 = texts(section(render(spine, legacy), "fixed:1"))
    expect(s1.slice(0, 4)).toEqual(["1.1 External Systems", "Email Service: sends notifications", "[image png:media:word/media/image1.png]", "FAP manages attendance."])
    expect(s1).toContain("# External Systems")
  })
})
