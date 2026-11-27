import { beforeEach, describe, expect, it } from "vitest"
import type { Block, RenderedSection } from "../render/rendered-document.types.js"
import type { TemplateLayout } from "../render/layout-sections.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import { _clearDocumentDiffCache, crDocumentDiff, diffSections, locationResolver, renderedToDiffBlocks, type CrDocumentDiffDeps } from "./cr-document-diff.service.js"

const run = (text: string) => [{ text }]
const para = (text: string, entity_path?: string): Block => ({ type: "paragraph", runs: run(text), ...(entity_path ? { entity_path } : {}) })
const table = (rows: string[][], paths?: (string | null)[]): Block => ({
  type: "table",
  header: [run("ID"), run("Message")],
  rows: rows.map((r) => r.map(run)),
  ...(paths ? { row_entity_paths: paths } : {})
})
const section = (id: string, blocks: Block[], heading = "Sec"): RenderedSection => ({ id, number: "1", heading, level: 2, blocks })
const resolveNone = (): undefined => undefined

describe("renderedToDiffBlocks", () => {
  it("block_id = entity_path của đoạn; trùng ⇒ thêm #n; heading / bảng / danh sách không neo; bỏ ảnh và ngắt trang", () => {
    const blocks: Block[] = [
      { type: "heading", level: 3, text: "Title" },
      para("a", "functions[id=FN1]"),
      para("b", "functions[id=FN1]"),
      para("c"),
      { type: "image", png: "x" },
      { type: "page_break" },
      table([["M1", "x"]])
    ]
    const out = renderedToDiffBlocks(blocks)
    expect(out.map((d) => d.block_id)).toEqual([null, "functions[id=FN1]", "functions[id=FN1]#1", null, null])
    expect(out.map((d) => d.kind)).toEqual(["heading", "paragraph", "paragraph", "paragraph", "table"])
  })
})

describe("diffSections", () => {
  it("mục không đổi ⇒ không trả", () => {
    const s = section("fixed:1", [para("a", "p[id=1]")])
    expect(diffSections([s], [s], resolveNone)).toEqual([])
  })

  it("đoạn sửa ⇒ modified kèm chữ cũ; đoạn thêm ⇒ added; đoạn xoá chèn lại đúng chỗ; location theo entity_path", () => {
    const before = section("fixed:1", [para("one", "e[id=1]"), para("two old", "e[id=2]"), para("three", "e[id=3]")])
    const after = section("fixed:1", [para("one", "e[id=1]"), para("two new", "e[id=2]"), para("four", "e[id=4]")])
    const [s] = diffSections([before], [after], (path) => (path === "e[id=2]" ? "L1" : path === "e[id=4]" ? "L2" : path === "e[id=3]" ? "L3" : undefined))
    expect(s.change).toBe("modified")
    expect(s.blocks.map((b) => [b.change, b.location_id])).toEqual([
      ["unchanged", undefined],
      ["modified", "L1"],
      ["removed", "L3"],
      ["added", "L2"]
    ])
    expect(s.blocks[1].before).toBe("two old")
    // block trả ra không mang entity_path thô
    expect(JSON.stringify(s)).not.toContain("entity_path")
  })

  it("dòng bảng bị xoá / thêm / sửa theo row_entity_paths", () => {
    const before = section("fixed:5.3", [table([["M1", "Hello"], ["M2", "Bye"], ["M3", "Keep"]], ["m[id=1]", "m[id=2]", "m[id=3]"])])
    const after = section("fixed:5.3", [table([["M1", "Hello there"], ["M3", "Keep"], ["M4", "New"]], ["m[id=1]", "m[id=3]", "m[id=4]"])])
    const [s] = diffSections([before], [after], (path) => path ?? undefined)
    const [t] = s.blocks
    expect(t.change).toBe("modified")
    expect(t.rows!.map((r) => [r.cells[0][0].text, r.change, r.location_id])).toEqual([
      ["M1", "modified", "m[id=1]"],
      ["M2", "removed", "m[id=2]"],
      ["M3", "unchanged", undefined],
      ["M4", "added", "m[id=4]"]
    ])
    expect(t.rows![0].cells_changed).toEqual([1])
    expect(t.rows![0].before).toEqual(["M1", "Hello"])
  })

  it("chỉ đổi thứ tự dòng ⇒ không phải thay đổi", () => {
    const before = section("s", [table([["M1", "a"], ["M2", "b"]], ["m[id=1]", "m[id=2]"])])
    const after = section("s", [table([["M2", "b"], ["M1", "a"]], ["m[id=2]", "m[id=1]"])])
    expect(diffSections([before], [after], resolveNone)).toEqual([])
  })

  it("mục danh sách xoá / thêm", () => {
    const list = (items: string[], paths: string[]): Block => ({ type: "bullet_list", items: items.map(run), item_entity_paths: paths })
    const before = section("s", [list(["x", "y"], ["a[id=1]", "a[id=2]"])])
    const after = section("s", [list(["x", "z"], ["a[id=1]", "a[id=3]"])])
    const [s] = diffSections([before], [after], (p) => p ?? undefined)
    expect(s.blocks[0].items!.map((i) => [i.runs[0].text, i.change, i.location_id])).toEqual([
      ["x", "unchanged", undefined],
      ["y", "removed", "a[id=2]"],
      ["z", "added", "a[id=3]"]
    ])
  })

  it("cả mục bị xoá ⇒ mọi block removed, chèn đúng chỗ giữa các mục; mục thêm mới ⇒ added", () => {
    const keep = (id: string) => section(id, [para(id, `k[id=${id}]`)])
    const gone = section("function:FN2", [{ type: "heading", level: 3, text: "Gone" }, para("body", "functions[id=FN2]")])
    const fresh = section("function:FN9", [para("fresh", "functions[id=FN9]")])
    const out = diffSections([keep("a"), gone, keep("b")], [keep("a"), keep("b"), fresh], (p) => p ?? undefined)
    expect(out.map((s) => [s.id, s.change])).toEqual([
      ["function:FN2", "removed"],
      ["function:FN9", "added"]
    ])
    expect(out[0].blocks.every((b) => b.change === "removed")).toBe(true)
    expect(out[0].blocks[1].location_id).toBe("functions[id=FN2]")
  })
})

describe("diffSections - chỗ sửa không được bị nuốt", () => {
  it("dòng vừa đổi chữ vừa đổi vị trí (bảng xếp theo tên, CR đổi tên) ⇒ vẫn là modified", () => {
    const before = section("s", [table([["UC1", "Alpha"], ["UC2", "Beta"], ["UC3", "Gamma"]], ["u[id=1]", "u[id=2]", "u[id=3]"])])
    const after = section("s", [table([["UC2", "Beta"], ["UC3", "Gamma"], ["UC1", "Zeta"]], ["u[id=2]", "u[id=3]", "u[id=1]"])])
    const [s] = diffSections([before], [after], (p) => p ?? undefined)
    const changed = s.blocks[0].rows!.filter((r) => r.change !== "unchanged")
    expect(changed.map((r) => [r.cells[0][0].text, r.change, r.location_id])).toEqual([["UC1", "modified", "u[id=1]"]])
  })

  it("đoạn có neo vừa đổi chữ vừa đổi chỗ ⇒ modified", () => {
    const before = section("s", [para("first", "e[id=1]"), para("second old", "e[id=2]"), para("third", "e[id=3]")])
    const after = section("s", [para("third", "e[id=3]"), para("first", "e[id=1]"), para("second new", "e[id=2]")])
    const [s] = diffSections([before], [after], (p) => p ?? undefined)
    expect(s.blocks.filter((b) => b.change !== "unchanged").map((b) => [b.change, b.before, b.location_id])).toEqual([["modified", "second old", "e[id=2]"]])
  })

  it("danh sách thay bằng bảng (hoặc đánh số ↔ gạch đầu dòng) ⇒ khối cũ removed + khối mới added, không mất chữ cũ", () => {
    const bullets: Block = { type: "bullet_list", items: [run("old one"), run("old two")] }
    const numbered: Block = { type: "numbered_list", items: [run("old one"), run("old two")] }
    const [asTable] = diffSections([section("s", [bullets])], [section("s", [table([["A", "b"]])])], resolveNone)
    expect(asTable.blocks.map((b) => [b.block.type, b.change])).toEqual([["bullet_list", "removed"], ["table", "added"]])
    expect(asTable.blocks[0].items!.map((i) => i.change)).toEqual(["removed", "removed"])
    const [asNumbered] = diffSections([section("s", [bullets])], [section("s", [numbered])], resolveNone)
    expect(asNumbered.blocks.map((b) => [b.block.type, b.change])).toEqual([["bullet_list", "removed"], ["numbered_list", "added"]])
  })

  it("chỉ đổi hàng tiêu đề bảng ⇒ modified kèm header_before, tính là một thay đổi", () => {
    const withHeader = (name: string): Block => ({ type: "table", header: [run("ID"), run(name)], rows: [[run("M1"), run("x")]], row_entity_paths: ["m[id=1]"] })
    const out = diffSections([section("s", [withHeader("Name")])], [section("s", [withHeader("Title")])], resolveNone)
    expect(out).toHaveLength(1)
    expect(out[0].blocks[0]).toMatchObject({ change: "modified", header_before: ["ID", "Name"] })
    expect(out[0].blocks[0].rows!.every((r) => r.change === "unchanged")).toBe(true)
  })

  it("mục có nhiều vị trí edit mà dòng không gắn phần tử ⇒ không đoán location_id; chỉ một vị trí thì rơi về vị trí đó", () => {
    const edit = (location_id: string, path: string, section_id: string) => ({ location_id, path, section_id, entity_paths: [], conclusion: "edit" as const, proposal: null })
    const one = locationResolver([edit("L1", "x[id=1]", "fixed:5.3")])
    expect(one(null, "fixed:5.3")).toBe("L1")
    expect(one(null, "fixed:5.4")).toBeUndefined()
    const two = locationResolver([edit("L1", "x[id=1]", "fixed:5.3"), edit("L2", "x[id=2]", "fixed:5.3")])
    expect(two(null, "fixed:5.3")).toBeUndefined()
    // có đường dẫn phần tử thì vẫn khớp đúng vị trí
    expect(two("x[id=2]", "fixed:5.3")).toBe("L2")
  })
})

// ─── Service ──────────────────────────────────────────────────────

const entry = (order: number, heading_text: string, level: number, section_id: string) => ({ order, heading_text, level, section_id })

const baseSpine = (): Spine => ({
  ...createEmptySpine({ name: "Lumen" }),
  features: [{ id: "F-4", name: "Chức năng", order: 0 }],
  functions: [
    {
      id: "FN02",
      screen_id: null,
      feature_id: "F-4",
      order: 1,
      name: "Đăng nhập",
      trigger: "Học viên bấm Đăng nhập.",
      description: "Vào hệ thống.",
      normal: ["Nhập mật khẩu."],
      abnormal: [],
      validations: [],
      business_rule_ids: [],
      priority: null
    },
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
  ]
})

const template: TemplateLayout = {
  language: "vi",
  layout: [entry(0, "4 Chức năng", 1, "feature:F-4"), entry(1, "4.1 Đăng ký", 2, "function:FN01")]
}

const location = (over: Partial<IChangeLocation>): IChangeLocation =>
  ({
    location_id: "L001",
    path: "functions[id=FN01]",
    section_id: "function:FN01",
    entity_paths: [],
    found_by: ["keyword"],
    conclusion: "edit",
    proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: [] },
    ...over
  }) as unknown as IChangeLocation

const deps = (spine: Spine, locations: IChangeLocation[], tpl: TemplateLayout | null = template): CrDocumentDiffDeps => ({
  loadSpine: async () => spine,
  loadLocations: async () => locations,
  loadTemplate: async () => tpl
})

const cr = { projectId: "p1", cr_id: "CR-001" } as never

beforeEach(() => _clearDocumentDiffCache())

describe("crDocumentDiff", () => {
  it("không đề xuất ⇒ không có mục đổi", async () => {
    const res = await crDocumentDiff(cr, deps(baseSpine(), []))
    expect(res).toMatchObject({ cr_id: "CR-001", change_count: 0, sections: [] })
  })

  it("xoá chức năng ⇒ mục của nó hiện removed, mỗi block gắn đúng vị trí; không ghi Spine", async () => {
    const spine = baseSpine()
    const snapshot = JSON.stringify(spine)
    const loc = location({ proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: [{ op: "remove", path: "functions[id=FN01]" }] } })
    const res = await crDocumentDiff(cr, deps(spine, [loc]))
    const fn = res.sections.find((s) => s.id === "function:FN01")
    expect(fn?.change).toBe("removed")
    expect(fn!.location_ids).toEqual(["L001"])
    expect(fn!.blocks.some((b) => b.location_id === "L001")).toBe(true)
    expect(res.change_count).toBeGreaterThan(0)
    expect(JSON.stringify(spine)).toBe(snapshot)
  })

  it("sửa mô tả chức năng ⇒ mục modified", async () => {
    const loc = location({
      proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: [{ op: "set", path: "functions[id=FN01].description", value: "Tạo tài khoản mới bằng email." }] }
    })
    const res = await crDocumentDiff(cr, deps(baseSpine(), [loc]))
    const fn = res.sections.find((s) => s.id === "function:FN01")
    expect(fn?.change).toBe("modified")
    expect(fn!.blocks.some((b) => b.change === "modified" || b.change === "added")).toBe(true)
  })

  it("vị trí không phải edit (comment / không liên quan) ⇒ không đổi gì", async () => {
    const loc = location({
      conclusion: "comment",
      proposal: { old_text: "", new_text: null, comment_text: "x", spine_ops: [{ op: "remove", path: "functions[id=FN01]" }] }
    })
    expect((await crDocumentDiff(cr, deps(baseSpine(), [loc]))).sections).toEqual([])
  })

  it("dự án không có layout file ⇒ rỗng", async () => {
    expect((await crDocumentDiff(cr, deps(baseSpine(), [location({})], null))).sections).toEqual([])
  })

  it("cache: cùng đầu vào trúng, đổi đề xuất / spine_version / layout ⇒ trượt", async () => {
    let loads = 0
    const spine = baseSpine()
    const op = (value: string) => ({ op: "set", path: "functions[id=FN01].description", value })
    const withOps = (value: string) => location({ proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: [op(value)] } })
    const counting = (s: Spine, locs: IChangeLocation[], tpl: TemplateLayout = template): CrDocumentDiffDeps => ({
      loadSpine: async () => s,
      loadLocations: async () => {
        loads++
        return locs
      },
      loadTemplate: async () => tpl
    })
    const first = await crDocumentDiff(cr, counting(spine, [withOps("A")]))
    const again = await crDocumentDiff(cr, counting(spine, [withOps("A")]))
    expect(again).toBe(first)
    const edited = await crDocumentDiff(cr, counting(spine, [withOps("B")]))
    expect(edited).not.toBe(first)
    const bumped = await crDocumentDiff(cr, counting(structuredClone({ ...spine, spine_version: spine.spine_version + 1 }), [withOps("A")]))
    expect(bumped).not.toBe(first)
    const relayout = await crDocumentDiff(cr, counting(spine, [withOps("A")], { ...template, language: "en" }))
    expect(relayout).not.toBe(first)
    expect(loads).toBe(5)
  })
})
