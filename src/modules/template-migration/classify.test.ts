import { describe, expect, it } from "vitest"
import { classify, columnIdentity, decidableItems, missingAfterMoves, sameColumns, settleDecisions, tableShapesBySection, type TableShape, type TableShapes } from "./classify.js"
import { pairSections, type NewHeading, type OldHeading } from "./pair-sections.js"
import type { EditedSection } from "./edited-since.js"

const old = (key: string, heading_text: string, level: number, section_id = key): OldHeading => ({ key, heading_text, level, section_id })
const neu = (index: number, heading_text: string, section_id: string, extra: Partial<NewHeading> = {}): NewHeading => ({ key: `n${index}`, heading_text, section_id, ...extra })
const shape = (...columns: string[]): TableShape => ({ columns })
const tables = (entries: Record<string, TableShape[]>): TableShapes => new Map(Object.entries(entries))

const run = (oldDoc: OldHeading[], newDoc: NewHeading[], extra: { oldTables?: TableShapes; newTables?: TableShapes; edited?: EditedSection[] | null } = {}) => {
  const pairing = pairSections(oldDoc, newDoc)
  return { pairing, groups: classify({ old: oldDoc, neu: newDoc, pairing, ...extra }) }
}

describe("classify — 4 nhóm cho một lần đổi mẫu v1 → v2", () => {
  const oldDoc = [
    old("fixed:1", "1 Product Overview", 1),
    old("fixed:2.1", "2.1 Actors", 2),
    old("fixed:5.1", "5.1 Business Rules", 2),
    old("custom:c1", "5.9 Team Notes", 2),
    old("custom:c2", "9 Legacy Interfaces", 1)
  ]
  const newDoc = [
    neu(0, "1 Introduction", "fixed:1"),
    neu(1, "2.1 Actors", "fixed:2.1"),
    neu(2, "5.1 Business Rules", "fixed:5.1"),
    neu(3, "Team notes", "unmapped"),
    neu(4, "6 Operating Environment", "unmapped", { guidance: "Describe the environment." }),
    neu(5, "2.2.2 Use Case Descriptions", "fixed:2.2.2")
  ]
  const oldTables = tables({ "fixed:2.1": [shape("h:actor", "h:description")], "fixed:5.1": [shape("h:br id", "h:business rule")] })
  const newTables = tables({ "fixed:2.1": [shape("h:actor", "h:description")], "fixed:5.1": [shape("h:br id", "h:business rule", "h:priority")] })

  it("khớp / thiếu / thừa / conflict đúng nhóm", () => {
    const { groups } = run(oldDoc, newDoc, { oldTables, newTables })
    expect(groups.matched.map((m) => [m.old_key, m.new_key])).toEqual([["fixed:1", "n0"], ["fixed:2.1", "n1"], ["custom:c1", "n3"]])
    expect(groups.missing.map((m) => [m.new_key, m.needs_content, m.guidance])).toEqual([["n4", true, "Describe the environment."], ["n5", true, null]])
    expect(groups.extra.map((e) => e.old_key)).toEqual(["custom:c2"])
    expect(groups.conflict).toMatchObject([{ kind: "table_columns", old_key: "fixed:5.1", new_key: "n2", choices: ["map_by_header", "keep_old_table", "ai_resolve"] }])
  })

  it("mục thừa: giữ / xoá / chuyển vào mục thiếu; chuyển vào mục có cấu trúc cần AI", () => {
    const { groups } = run(oldDoc, newDoc, { oldTables, newTables })
    expect(groups.extra[0]).toMatchObject({ id: "e:custom:c2", choices: ["keep_custom", "delete", "move_to:n4", "move_to:n5"], ai_choices: ["move_to:n5"], decision_required: true })
  })

  it("đổi cột bảng chỉ là đổi thứ tự ⇒ vẫn khớp", () => {
    const reordered = tables({ "fixed:2.1": [shape("h:description", "h:actor")] })
    const { groups } = run(oldDoc, newDoc, { oldTables: tables({ "fixed:2.1": [shape("h:actor", "h:description")] }), newTables: reordered })
    expect(groups.conflict).toEqual([])
    expect(groups.matched.map((m) => m.old_key)).toContain("fixed:2.1")
  })

  it("mẫu đích không có bảng mà bảng cũ có ⇒ conflict, không có lựa chọn ghép cột", () => {
    const { groups } = run(oldDoc, newDoc, { oldTables, newTables: tables({}) })
    expect(groups.conflict.map((c) => [c.old_key, c.choices])).toEqual([
      ["fixed:2.1", ["keep_old_table", "delete", "ai_resolve"]],
      ["fixed:5.1", ["keep_old_table", "delete", "ai_resolve"]]
    ])
  })
})

describe("classify — Record of Changes", () => {
  const oldDoc = [old("fixed:I", "I. Record of Changes", 1)]
  const rocOld = tables({ "fixed:I": [shape("roc:date", "roc:version", "roc:change_type", "roc:in_charge", "roc:description")] })

  it("bảng mẫu đích khác cột ⇒ conflict record_of_changes", () => {
    const { groups } = run(oldDoc, [neu(0, "Revision History", "fixed:I")], { oldTables: rocOld, newTables: tables({ "fixed:I": [shape("roc:date", "roc:version", "roc:description")] }) })
    expect(groups.conflict).toMatchObject([{ kind: "record_of_changes", old_key: "fixed:I", new_key: "n0" }])
  })

  it("cùng bộ cột lịch sử (chữ tiêu đề khác nhưng cùng cột chuẩn) ⇒ khớp", () => {
    const { groups } = run(oldDoc, [neu(0, "Revision History", "fixed:I")], { oldTables: rocOld, newTables: tables({ "fixed:I": [shape("roc:description", "roc:date", "roc:in_charge", "roc:version", "roc:change_type")] }) })
    expect(groups.conflict).toEqual([])
    expect(groups.matched).toHaveLength(1)
  })

  it("mẫu đích không có Record of Changes ⇒ conflict (không tự xoá lịch sử), không phải mục thừa", () => {
    const { groups } = run(oldDoc, [neu(0, "1 Introduction", "fixed:1")], { oldTables: rocOld })
    expect(groups.extra).toEqual([])
    expect(groups.conflict).toMatchObject([{ kind: "record_of_changes", new_key: null, choices: ["keep_custom", "drop_from_print", "ai_resolve"] }])
  })

  it("columnIdentity: cột Record of Changes theo cột chuẩn, cột khác theo chữ gập dấu", () => {
    expect(columnIdentity("Ngày", null, "fixed:I")).toBe("roc:date")
    expect(columnIdentity("Mô tả", "x[].y", "fixed:2.1")).toBe("x[].y")
    expect(columnIdentity("Tên Tác nhân", null, "fixed:2.1")).toBe("h:ten tac nhan")
  })
})

describe("classify — mục bị tách", () => {
  it("mẫu đích tách một mục thành hai ⇒ conflict split_section với lựa chọn đặt vào từng phần", () => {
    const { groups } = run([old("fixed:4.2.2", "4.2.2 Reliability", 3)], [neu(0, "Reliability", "fixed:4.2.2"), neu(1, "Availability", "fixed:4.2.2")])
    expect(groups.missing).toEqual([])
    expect(groups.conflict).toMatchObject([{ kind: "split_section", candidate_keys: ["n0", "n1"], choices: ["to:n0", "to:n1", "ai_resolve"] }])
  })
})

describe("classify — 40 use case", () => {
  it("heading UC nằm dưới mục chứa phần tử không vào nhóm thừa", () => {
    const ucs = Array.from({ length: 40 }, (_, i) => old(`custom:uc${i}`, `UC-${String(i + 1).padStart(2, "0")} Flow ${i}`, 4))
    const oldDoc = [old("fixed:2.2.2", "2.2.2 Use Case Descriptions", 3), ...ucs]
    const { groups, pairing } = run(oldDoc, [neu(0, "2.2.2 Descriptions", "fixed:2.2.2")])
    expect(groups.extra).toEqual([])
    expect(groups.matched).toHaveLength(1)
    expect(pairing.followers.filter((f) => f.kind === "element")).toHaveLength(40)
  })
})

describe("classify — heading nhóm", () => {
  it("heading nhóm không còn ở mẫu đích và không có gì đi theo ⇒ bỏ khung, không hỏi", () => {
    const { groups } = run([old("group:2", "2 User Requirements", 1)], [neu(0, "1 Introduction", "fixed:1")])
    expect(groups.extra).toEqual([])
    expect(groups.structure_only_dropped).toEqual(["group:2"])
  })

  it("heading nhóm có phần nối / phần tử đi theo ⇒ thành mục thừa kèm phần đi theo", () => {
    const { groups } = run([old("group:3", "3 Functional Requirements", 1), old("feature:F01", "3.2 Auth", 2)], [neu(0, "1 Introduction", "fixed:1")])
    expect(groups.extra).toMatchObject([{ old_key: "group:3", follower_keys: ["feature:F01"] }])
  })
})

describe("classify — heading nhóm của mẫu đích và mục nhận nội dung chuyển vào (test tay 11/11)", () => {
  const oldDoc = [old("fixed:1", "1. Product Overview", 1), old("fixed:4.2.4", "4.2.4 Domain-Specific Attributes", 2), old("custom:c9", "5.9 Team Notes", 2)]
  const newDoc = [
    neu(0, "II. Software Requirement Specification", "unmapped", { level: 1 }),
    neu(1, "1. Product Overview", "fixed:1", { level: 2 }),
    neu(2, "4.2.4 …", "unmapped", { level: 4 }),
    neu(3, "Appendix", "unmapped", { level: 2 })
  ]

  it("heading nhóm (heading sau sâu hơn) không cần viết và không là đích chuyển vào; heading lá vẫn cần viết", () => {
    const { groups } = run(oldDoc, newDoc)
    expect(groups.missing.map((m) => [m.heading_text, m.needs_content])).toEqual([
      ["II. Software Requirement Specification", false],
      ["4.2.4 …", true],
      ["Appendix", true]
    ])
    expect(groups.extra.find((e) => e.old_key === "custom:c9")?.choices).not.toContain("move_to:n0")
    // Mục khung chuyển chỗ in không gọi AI ⇒ không có lựa chọn AI (không nhãn "dùng AI", không tính credit)
    expect(groups.extra.find((e) => e.old_key === "fixed:4.2.4")?.ai_choices).toEqual([])
  })

  it("không biết cấp heading ⇒ giữ như cũ (cần viết)", () => {
    const { groups } = run(oldDoc, newDoc.map(({ level: _level, ...n }) => n))
    expect(groups.missing.find((m) => m.new_key === "n0")?.needs_content).toBe(true)
  })

  it("missingAfterMoves: mục là đích move_to nhận nội dung ⇒ không cần viết, ghi mục chuyển vào; quyết định khác không đổi", () => {
    const { groups } = run(oldDoc, newDoc)
    const after = missingAfterMoves(groups, [{ id: "e:custom:c9", choice: "move_to:n2" }, { id: "e:x", choice: "keep_custom" }])
    expect(after.missing.find((m) => m.new_key === "n2")).toMatchObject({ needs_content: false, moved_in: ["e:custom:c9"] })
    expect(after.missing.find((m) => m.new_key === "n3")).toMatchObject({ needs_content: true })
    expect(after.missing.find((m) => m.new_key === "n3")?.moved_in).toBeUndefined()
    expect(missingAfterMoves(groups, [])).toBe(groups)
  })
})

describe("classify — đổi ngược: nhóm đã sửa sau lần đổi mẫu", () => {
  const oldDoc = [old("fixed:1", "1 Introduction", 1), old("fixed:2.1", "2.1 Actors", 2), old("custom:c1", "Wrong-template notes", 2)]
  const newDoc = [neu(0, "1 Product Overview", "fixed:1"), neu(1, "2.1 Actors", "fixed:2.1")]
  const edited: EditedSection[] = [{ key: "fixed:2.1", changes: 3, last_at: "2026-11-11T10:00:00.000Z", chars: 120 }]

  it("mục đã sửa vào nhóm riêng (mặc định keep), mục chưa sửa chỉ đếm, mục viết thêm cho mẫu sai ⇒ nhóm thừa", () => {
    const { groups } = run(oldDoc, newDoc, { edited })
    expect(groups.edited_since).toEqual([{ id: "s:fixed:2.1", old_key: "fixed:2.1", heading_text: "2.1 Actors", changes: 3, last_at: "2026-11-11T10:00:00.000Z", chars: 120, choices: ["keep", "discard"], default: "keep" }])
    expect(groups.restored_from_snapshot).toBe(1)
    expect(groups.matched.map((m) => m.old_key)).toEqual(["fixed:1"])
    expect(groups.extra.map((e) => e.old_key)).toEqual(["custom:c1"])
  })

  it("đổi xuôi không có nhóm này", () => {
    const { groups } = run(oldDoc, newDoc, { edited: null })
    expect(groups.edited_since).toEqual([])
    expect(groups.restored_from_snapshot).toBeNull()
  })

  it("mục đã sửa nhưng không có chỗ ở mẫu đích ⇒ chỉ ở nhóm thừa, không ở nhóm đã sửa", () => {
    const { groups } = run(oldDoc, newDoc, { edited: [{ key: "custom:c1", changes: 1, last_at: "2026-11-11T10:00:00.000Z", chars: 5 }] })
    expect(groups.edited_since).toEqual([])
    expect(groups.extra.map((e) => e.old_key)).toEqual(["custom:c1"])
  })
})

describe("quyết định", () => {
  const oldDoc = [old("fixed:5.1", "5.1 Business Rules", 2), old("custom:c2", "Legacy", 1), old("fixed:2.1", "2.1 Actors", 2)]
  const newDoc = [neu(0, "5.1 Business Rules", "fixed:5.1"), neu(1, "2.1 Actors", "fixed:2.1")]
  const { groups } = run(oldDoc, newDoc, {
    oldTables: tables({ "fixed:5.1": [shape("h:a")] }),
    newTables: tables({ "fixed:5.1": [shape("h:b")] }),
    edited: [{ key: "fixed:2.1", changes: 1, last_at: "2026-11-11T10:00:00.000Z", chars: 1 }]
  })

  it("chỉ mục thừa / conflict / đã sửa nhận quyết định; thừa + conflict bắt buộc", () => {
    const items = decidableItems(groups)
    expect([...items.keys()].sort()).toEqual(["c:table_columns:fixed:5.1", "e:custom:c2", "s:fixed:2.1"])
    expect(items.get("s:fixed:2.1")).toMatchObject({ group: "edited_since", required: false, default: "keep" })
  })

  it("settleDecisions: thiếu quyết định bắt buộc ⇒ undecided; quyết định sai nhóm bị loại", () => {
    const r = settleDecisions(groups, [{ id: "e:custom:c2", choice: "delete" }, { id: "c:table_columns:fixed:5.1", choice: "keep_custom" }, { id: "m:fixed:1", choice: "keep" }])
    expect(r.decisions).toEqual([{ id: "e:custom:c2", choice: "delete" }])
    expect(r.undecided).toEqual(["c:table_columns:fixed:5.1"])
  })
})

describe("tableShapesBySection", () => {
  it("dùng field_path của mapping nếu có, chữ tiêu đề nếu không; bỏ bảng không thuộc mục nào", () => {
    const shapes = tableShapesBySection(
      [
        { block_id: "B1", section_id: "fixed:2.1", rows: [["Actor", "Description"], ["a", "b"]] },
        { block_id: "B2", section_id: null, rows: [["x"]] },
        { block_id: "B3", section_id: "fixed:2.1", rows: null }
      ],
      new Map([["B1#0", "actors[].name"]])
    )
    expect([...shapes.keys()]).toEqual(["fixed:2.1"])
    expect(shapes.get("fixed:2.1")).toEqual([{ columns: ["actors[].name", "h:description"], headers: ["Actor", "Description"] }])
    expect(sameColumns(shape("a", "b"), shape("b", "a"))).toBe(true)
  })
})

describe("so cột bảng giữa hai phía", () => {
  const headers = ["Use Case ID", "Use Case Name", "Actor"]
  const oldShape: TableShape = { columns: ["use_cases[].id", "use_cases[].name", "actors[].name"], headers }
  const newShape: TableShape = { columns: ["h:use case id", "h:use case name", "use_cases[].actor_ids"], headers }

  it("cùng chữ tiêu đề nhưng chỉ một phía có field ⇒ cùng bộ cột, không báo bảng đổi cột", () => {
    expect(sameColumns(oldShape, newShape)).toBe(true)
    const oldDoc = [old("fixed:2.2.2", "2.2.2 Use Case Descriptions", 3)]
    const newDoc = [neu(0, "2.2.2 Use Case Descriptions", "fixed:2.2.2")]
    const { groups } = run(oldDoc, newDoc, { oldTables: tables({ "fixed:2.2.2": [oldShape] }), newTables: tables({ "fixed:2.2.2": [newShape] }) })
    expect(groups.conflict).toEqual([])
    expect(groups.matched.map((m) => m.old_key)).toEqual(["fixed:2.2.2"])
  })

  it("bảng thật sự đổi cột vẫn là conflict, và mô tả cột là chữ tiêu đề chứ không phải khoá nội bộ", () => {
    const changed: TableShape = { columns: ["h:use case id", "h:priority"], headers: ["Use Case ID", "Priority"] }
    const oldDoc = [old("fixed:2.2.2", "2.2.2 Use Case Descriptions", 3)]
    const newDoc = [neu(0, "2.2.2 Use Case Descriptions", "fixed:2.2.2")]
    const { groups } = run(oldDoc, newDoc, { oldTables: tables({ "fixed:2.2.2": [oldShape] }), newTables: tables({ "fixed:2.2.2": [changed] }) })
    expect(groups.conflict).toMatchObject([{ kind: "table_columns", old_columns: [headers], new_columns: [["Use Case ID", "Priority"]] }])
  })

  it("bảng lưu từ trước không có headers: mô tả bỏ tiền tố `h:`", () => {
    const oldDoc = [old("fixed:5.1", "5.1 Business Rules", 2)]
    const newDoc = [neu(0, "5.1 Business Rules", "fixed:5.1")]
    const { groups } = run(oldDoc, newDoc, { oldTables: tables({ "fixed:5.1": [shape("h:br id", "h:business rule")] }), newTables: tables({ "fixed:5.1": [shape("h:br id")] }) })
    expect(groups.conflict[0].old_columns).toEqual([["br id", "business rule"]])
  })
})
