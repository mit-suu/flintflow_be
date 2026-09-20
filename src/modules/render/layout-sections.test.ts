/**
 * Mode 1 v2 — render theo layout file người dùng (FLF-184, plan v2 §6). Hàm thuần: không DB.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { buildLayoutSections, customBlocks, numberSections, placeSections, type TemplateLayout, type TemplateLayoutEntry } from "./layout-sections.js"

const entry = (order: number, heading_text: string, level: number, section_id: string): TemplateLayoutEntry => ({ order, heading_text, level, section_id })

/** File kiểu "SRS_Lumen" (plan v2 §2.1): 1 Giới thiệu · 2 Actors · 3 Use Cases · 4 Chức năng › 4.1 Đăng ký · 5 NFR › 5.3 Bảo mật · Phụ lục A. */
const spine = (): Spine => ({
  ...createEmptySpine({ name: "Lumen" }),
  project: { ...createEmptySpine({ name: "Lumen" }).project, vision: "Lumen là nền tảng học trực tuyến." },
  actors: [{ id: "A01", name: "Học viên", kind: "human", description: "Người học." }],
  features: [{ id: "F-4", name: "Chức năng", order: 0 }],
  functions: [
    {
      id: "FN01",
      screen_id: null,
      feature_id: "F-4",
      order: 0,
      name: "Đăng ký",
      trigger: "Học viên bấm Đăng ký.",
      description: "Tạo tài khoản.",
      normal: ["Nhập email."],
      abnormal: [],
      validations: [],
      business_rule_ids: [],
      priority: null
    }
  ],
  nfrs: [{ id: "NFR-01", category: "performance", kind: "quantitative", statement: "Trang tải nhanh", metric: "p95", threshold: "2 s", priority: null }],
  custom_sections: [
    { id: "CS01", heading: "", level: 2, source: "import", blocks: [{ kind: "paragraph", text: "Tài liệu này mô tả Lumen.", rows: null, image_ref: null }] },
    {
      id: "CS02",
      heading: "Phụ lục A Biên bản họp",
      level: 1,
      source: "import",
      blocks: [
        { kind: "list_item", text: "Họp 12/09", rows: null, image_ref: null },
        { kind: "list_item", text: "Họp 19/09", rows: null, image_ref: null },
        { kind: "table", text: "", rows: [["Ngày", "Nội dung", "Người"], ["12/09", "Kick-off"]], image_ref: null }
      ]
    }
  ]
})

const LAYOUT: TemplateLayout = {
  language: "vi",
  layout: [
    entry(0, "1 Giới thiệu", 1, "fixed:1"),
    entry(1, "", 2, "custom:CS01"),
    entry(2, "2 Actors", 1, "fixed:2.1"),
    entry(3, "4 Chức năng", 1, "feature:F-4"),
    entry(4, "4.1 Đăng ký", 2, "function:FN01"),
    entry(5, "4.2 Đăng nhập", 2, "function:FN99"), // function đã xoá khỏi Spine
    entry(6, "5 NFR", 1, "group:4"),
    entry(7, "5.2 Hiệu năng", 2, "fixed:4.2.3"),
    entry(8, "Phụ lục A Biên bản họp", 1, "custom:CS02")
  ]
}

describe("placeSections — thứ tự theo file, chèn đầu mục FPT thiếu", () => {
  it("mục layout giữ thứ tự + tiêu đề gốc (bỏ số gõ tay); mục đã xoá khỏi Spine bị bỏ; mục FPT thiếu chèn sau section FPT gần nhất đứng trước", () => {
    const placed = placeSections(spine(), LAYOUT)
    const ids = placed.map((p) => p.section_id)
    expect(ids).not.toContain("function:FN99")
    // Mục của file đúng thứ tự tương đối
    const fileOrder = ["fixed:1", "custom:CS01", "fixed:2.1", "feature:F-4", "function:FN01", "group:4", "fixed:4.2.3", "custom:CS02"]
    expect(ids.filter((id) => fileOrder.includes(id))).toEqual(fileOrder)
    // Use case diagram/descriptions (thiếu) ngay sau Actors, trước chương chức năng
    expect(ids.slice(ids.indexOf("fixed:2.1"), ids.indexOf("feature:F-4"))).toEqual(["fixed:2.1", "fixed:2.2.1", "fixed:2.2.2", "fixed:3.1.1", "fixed:3.1.2", "fixed:3.1.3", "fixed:3.1.4", "fixed:3.1.5"])
    // 4.2.4 thiếu ⇒ ngay sau 5.2 Hiệu năng, cùng cấp; §5 (Business Rules…) chèn sau đó
    const perf = placed.find((p) => p.section_id === "fixed:4.2.3")!
    const other = placed.find((p) => p.section_id === "fixed:4.2.4")!
    expect(ids.indexOf("fixed:4.2.4")).toBe(ids.indexOf("fixed:4.2.3") + 1)
    expect(other.level).toBe(perf.level)
    expect(ids.indexOf("fixed:5.1")).toBeGreaterThan(ids.indexOf("fixed:4.2.4"))
    // Tiêu đề: gốc bỏ số; chèn thêm ⇒ tiêu đề FPT tiếng Việt
    expect(placed.find((p) => p.section_id === "fixed:1")?.title).toBe("Giới thiệu")
    expect(placed.find((p) => p.section_id === "fixed:5.1")?.title).toBe("Quy tắc nghiệp vụ")
    expect(placed.find((p) => p.section_id === "custom:CS01")?.kind).toBe("continuation")
  })

  it("function mới của feature (chưa có trong layout) ⇒ mục con của feature, sau function cũ", () => {
    const s = spine()
    s.functions.push({ ...s.functions[0], id: "FN02", order: 1, name: "Quên mật khẩu" })
    const placed = placeSections(s, LAYOUT)
    const ids = placed.map((p) => p.section_id)
    expect(ids.indexOf("function:FN02")).toBe(ids.indexOf("function:FN01") + 1)
    expect(placed.find((p) => p.section_id === "function:FN02")).toMatchObject({ level: 2, title: "Quên mật khẩu", fromLayout: false })
  })

  it("mục thiếu có anh em cùng nhóm trong file ⇒ chèn cạnh anh em: trước anh em đứng sau, sau anh em đứng trước (sau cả mục con)", () => {
    const layout: TemplateLayout = {
      language: "en",
      layout: [
        entry(0, "2.1 Actors", 2, "fixed:2.1"),
        entry(1, "3.1.2 Screen Descriptions", 3, "fixed:3.1.2"),
        entry(2, "5.1 Business Rules", 2, "fixed:5.1"),
        entry(3, "5.1.1 Notes", 3, "custom:N"),
        entry(4, "5.9 Team Notes", 2, "custom:T")
      ]
    }
    const s: Spine = {
      ...createEmptySpine({ name: "x" }),
      custom_sections: [
        { id: "N", heading: "5.1.1 Notes", level: 3, source: "import", blocks: [] },
        { id: "T", heading: "5.9 Team Notes", level: 2, source: "import", blocks: [] }
      ]
    }
    const placed = placeSections(s, layout)
    const ids = placed.map((p) => p.section_id)
    expect(ids.indexOf("fixed:3.1.1")).toBe(ids.indexOf("fixed:3.1.2") - 1)
    expect(placed.find((p) => p.section_id === "fixed:3.1.1")?.level).toBe(3)
    expect(ids.slice(ids.indexOf("fixed:5.1"), ids.indexOf("custom:T"))).toEqual(["fixed:5.1", "custom:N", "fixed:5.2", "fixed:5.3", "fixed:5.4", "fixed:5.5"])
  })

  it("mục riêng thêm tay (chưa có trong layout) ⇒ cuối tài liệu", () => {
    const s = spine()
    s.custom_sections.push({ id: "CS09", heading: "Ghi chú thêm", level: 1, source: "manual", blocks: [] })
    const ids = placeSections(s, LAYOUT).map((p) => p.section_id)
    expect(ids.indexOf("custom:CS09")).toBeGreaterThan(ids.indexOf("custom:CS02"))
  })
})

describe("numberSections", () => {
  it("file gõ số tay: số đánh lại theo cấp (khớp số gốc khi không chèn gì); heading không gõ số (Phụ lục) giữ không số", () => {
    const layout: TemplateLayout = {
      language: "en",
      layout: [entry(0, "1 Intro", 1, "fixed:1"), entry(1, "1.1 Scope", 2, "custom:A"), entry(2, "2 Actors", 1, "fixed:2.1"), entry(3, "Appendix A", 1, "custom:B")]
    }
    const s: Spine = {
      ...createEmptySpine({ name: "x" }),
      custom_sections: [
        { id: "A", heading: "1.1 Scope", level: 2, source: "import", blocks: [] },
        { id: "B", heading: "Appendix A", level: 1, source: "import", blocks: [] }
      ]
    }
    const numbered = numberSections(placeSections(s, layout))
    const numberOf = (id: string) => numbered.find((n) => n.section_id === id)?.number
    expect(numberOf("fixed:1")).toBe("1")
    expect(numberOf("custom:A")).toBe("1.1")
    expect(numberOf("fixed:2.1")).toBe("2")
    expect(numberOf("fixed:2.2.1")).toBe("3") // chèn sau Actors, cùng cấp ⇒ các mục sau dịch số
    expect(numberOf("custom:B")).toBe("")
  })

  it("file đánh số tự động (không gõ số): mọi heading đều có số; cấp nhảy quá 1 kéo về cấp kế tiếp", () => {
    const layout: TemplateLayout = { language: "en", layout: [entry(0, "Intro", 1, "fixed:1"), entry(1, "Deep", 3, "custom:A")] }
    const s: Spine = { ...createEmptySpine({ name: "x" }), custom_sections: [{ id: "A", heading: "Deep", level: 3, source: "import", blocks: [] }] }
    const numbered = numberSections(placeSections(s, layout))
    expect(numbered.slice(0, 2).map((n) => [n.section_id, n.number, n.renderLevel])).toEqual([
      ["fixed:1", "1", 1],
      ["custom:A", "1.1", 2]
    ])
  })
})

describe("buildLayoutSections", () => {
  const build = (s: Spine = spine()) => buildLayoutSections(s, LAYOUT, [], { diagramPng: (id) => `ref:${id}` })

  it("section FPT: nội dung từ Spine, tiêu đề + cấp theo file, heading con dời cấp theo; nhãn cố định tiếng Việt", () => {
    const { sections } = build()
    const fn = sections.find((s) => s.id === "function:FN01")!
    expect(fn).toMatchObject({ heading: "Đăng ký", level: 2 })
    expect(fn.blocks[0]).toEqual({ type: "paragraph", runs: [{ text: "Kích hoạt: ", bold: true }, { text: "Học viên bấm Đăng ký." }] })
    // heading "Normal Flow" level 4 ở mẫu FPT (function level 3) ⇒ level 3 khi function ở cấp 2
    expect(fn.blocks).toContainEqual({ type: "heading", level: 3, text: "Luồng chính" })
    const perf = sections.find((s) => s.id === "fixed:4.2.3")!
    expect(perf.heading).toBe("Hiệu năng")
    expect(perf.blocks[0]).toMatchObject({ type: "table", header: [[{ text: "Yêu cầu" }], [{ text: "Chỉ số" }], [{ text: "Ngưỡng" }], [{ text: "Ưu tiên" }]] })
  })

  it("phần nối (văn xuôi không trích được) gộp vào đầu section chủ, không thành section riêng; group chỉ heading", () => {
    const { sections } = build()
    expect(sections.map((s) => s.id)).not.toContain("custom:CS01")
    const intro = sections.find((s) => s.id === "fixed:1")!
    expect(intro.blocks[0]).toEqual({ type: "paragraph", runs: [{ text: "Tài liệu này mô tả Lumen." }] })
    expect(intro.blocks[1]).toEqual({ type: "paragraph", runs: [{ text: "Lumen là nền tảng học trực tuyến." }] })
    expect(sections.find((s) => s.id === "group:4")).toMatchObject({ heading: "NFR", blocks: [] })
  })

  it("mục riêng render nguyên văn: danh sách gộp, bảng đệm đủ cột; số hiệu + tiêu đề cho phụ lục cờ", () => {
    const { sections, numbers, titles } = build()
    const appendix = sections.find((s) => s.id === "custom:CS02")!
    expect(appendix.heading).toBe("Phụ lục A Biên bản họp")
    expect(appendix.number).toBe("")
    expect(appendix.blocks[0]).toEqual({ type: "bullet_list", items: [[{ text: "Họp 12/09" }], [{ text: "Họp 19/09" }]] })
    expect(appendix.blocks[1]).toMatchObject({ type: "table", rows: [[[{ text: "12/09" }], [{ text: "Kick-off" }], [{ text: "" }]]] })
    expect(numbers.get("fixed:1")).toBe("1")
    expect(titles.get("custom:CS02")).toBe("Phụ lục A Biên bản họp")
  })

  it("section rỗng vẫn có mặt (FE hiện 'chưa có nội dung — chạy step'); partial bỏ section FPT rỗng", () => {
    expect(build().sections.find((s) => s.id === "fixed:5.1")).toMatchObject({ heading: "Quy tắc nghiệp vụ", blocks: [] })
    const partial = buildLayoutSections(spine(), LAYOUT, [], { partial: true, diagramPng: () => undefined })
    expect(partial.sections.map((s) => s.id)).not.toContain("fixed:5.1")
  })

  it("ngôn ngữ en ⇒ nhãn tiếng Anh như mode 2", () => {
    const { sections } = buildLayoutSections(spine(), { ...LAYOUT, language: "en" }, [], { diagramPng: () => undefined })
    expect(sections.find((s) => s.id === "fixed:5.1")?.heading).toBe("Business Rules")
    expect(sections.find((s) => s.id === "function:FN01")?.blocks[0]).toMatchObject({ runs: [{ text: "Trigger: " }, { text: "Học viên bấm Đăng ký." }] })
  })
})

describe("customBlocks", () => {
  it("bỏ đoạn rỗng, bảng rỗng; ảnh chưa đọc được (V5) ⇒ dòng chú thích nghiêng", () => {
    expect(
      customBlocks([
        { kind: "paragraph", text: "  ", rows: null, image_ref: null },
        { kind: "table", text: "", rows: [["", ""]], image_ref: null },
        { kind: "image", text: "Sơ đồ use case", rows: null, image_ref: null }
      ])
    ).toEqual([{ type: "paragraph", runs: [{ text: "[Image: Sơ đồ use case]", italic: true }] }])
  })
})
