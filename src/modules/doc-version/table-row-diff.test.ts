import { describe, expect, it } from "vitest"
import { textHash } from "../docx-ooxml/index.js"
import { diffBlockLists, type DiffBlock } from "./block-diff.js"
import { diffTableRows } from "./table-row-diff.js"
import { blankInChargeTable, compareWithoutAuthors } from "./versions.service.js"

const ROC_HEADER = ["Date", "A*M,D", "In charge", "Change description"]
const roc = (n: number): string[] => [`0${n}/11/2026`, "A", "Quynh", `Change ${n}`]

const reqHeader = ["ID", "Requirement", "Priority"]
const reqs = [
  ["NFR-01", "Page loads in 2 seconds", "High"],
  ["NFR-02", "99.9% uptime", "High"],
  ["NFR-03", "Supports 1000 users", "Medium"]
]

describe("diffTableRows", () => {
  it("thêm 3 hàng cuối ⇒ đúng 3 hàng added, hàng cũ gộp unchanged", () => {
    const before = [ROC_HEADER, roc(1), roc(2)]
    const after = [ROC_HEADER, roc(1), roc(2), roc(3), roc(4), roc(5)]
    const d = diffTableRows(before, after)!
    expect(d.header).toEqual(ROC_HEADER)
    expect(d.rows).toEqual([{ change: "unchanged", count: 2, rows: [roc(1), roc(2)] }, { change: "added", after: roc(3) }, { change: "added", after: roc(4) }, { change: "added", after: roc(5) }])
  })

  it("sửa 1 ô ⇒ 1 hàng modified, cells_changed đúng ô", () => {
    const after = [reqHeader, reqs[0], ["NFR-02", "99.95% uptime", "High"], reqs[2]]
    const d = diffTableRows([reqHeader, ...reqs], after)!
    expect(d.rows.filter((r) => r.change !== "unchanged")).toEqual([{ change: "modified", before: reqs[1], after: ["NFR-02", "99.95% uptime", "High"], cells_changed: [1] }])
  })

  it("xoá 1 hàng giữa ⇒ 1 hàng removed, đứng đúng chỗ", () => {
    const d = diffTableRows([ROC_HEADER, roc(1), roc(2), roc(3)], [ROC_HEADER, roc(1), roc(3)])!
    expect(d.rows).toEqual([{ change: "unchanged", count: 1, rows: [roc(1)] }, { change: "removed", before: roc(2) }, { change: "unchanged", count: 1, rows: [roc(3)] }])
  })

  it("đảo thứ tự hàng của bảng có cột mã ⇒ không thay đổi", () => {
    expect(diffTableRows([reqHeader, ...reqs], [reqHeader, reqs[2], reqs[0], reqs[1]])).toBeNull()
  })

  it("bảng có cột mã: sửa 1 ô của một hàng (kể cả khi đổi chỗ) ⇒ 1 modified, cells_changed đúng 1 ô", () => {
    const d = diffTableRows([reqHeader, ...reqs], [reqHeader, reqs[2], ["NFR-01", "Page loads in 2 seconds", "Low"], reqs[1]])!
    expect(d.rows.filter((r) => r.change !== "unchanged")).toEqual([{ change: "modified", before: reqs[0], after: ["NFR-01", "Page loads in 2 seconds", "Low"], cells_changed: [2] }])
  })

  it("bảng không cột mã chỉ đảo hàng ⇒ không có thay đổi (FLF-466)", () => {
    const h = ["Term", "Meaning"]
    const rows = [["Cart", "Items to buy"], ["Shop", "Seller page"], ["Order", "A purchase"]]
    expect(diffTableRows([h, ...rows], [h, rows[2], rows[0], rows[1]])).toBeNull()
  })

  it("bảng không cột mã đảo hàng và sửa một hàng ⇒ chỉ báo hàng sửa", () => {
    const h = ["Term", "Meaning"]
    const rows = [["Cart", "Items to buy"], ["Shop", "Seller page"], ["Order", "A purchase"]]
    const d = diffTableRows([h, ...rows], [h, rows[2], rows[0], ["Shop", "Seller page online"]])!
    expect(d.rows.some((r) => (r.change as string) === "moved")).toBe(false)
    expect(d.rows.filter((r) => r.change !== "unchanged").map((r) => r.change)).toEqual(["modified"])
  })

  it("hàng tiêu đề đổi ⇒ header_before", () => {
    const d = diffTableRows([["A", "B"], ["1", "2"]], [["A", "C"], ["1", "2"]])!
    expect(d).toMatchObject({ header: ["A", "C"], header_before: ["A", "B"] })
  })

  it("cột người thực hiện được che; hàng chỉ đổi ở cột đó không còn là thay đổi", () => {
    const d = diffTableRows([ROC_HEADER, roc(1)], [ROC_HEADER, ["01/11/2026", "A", "Hiep", "Change 1"], roc(2)])!
    const blanked = blankInChargeTable(d)
    expect(blanked.rows).toEqual([{ change: "added", after: ["02/11/2026", "A", "", "Change 2"] }])
  })
})

describe("compareWithoutAuthors với bảng", () => {
  it("bảng chỉ khác ở cột người thực hiện ⇒ không còn entry, bớt một \"sửa\", tính vào khối không đổi của mục", () => {
    const table = diffTableRows([ROC_HEADER, roc(1)], [ROC_HEADER, ["01/11/2026", "A", "Hiep", "Change 1"]])!
    const res = compareWithoutAuthors({ from: "0.1", to: "0.2", summary: { added: 0, removed: 0, modified: 1, moved: 0 }, blocks: [{ block_id: null, change: "modified", kind: "table", section: "I. RoC", table }], sections: [{ title: "I. RoC", unchanged: 0 }] })
    expect(res.blocks).toEqual([])
    expect(res.summary.modified).toBe(0)
    expect(res.sections).toEqual([{ title: "I. RoC", unchanged: 1 }])
  })
})

const block = (text: string, extra: Partial<DiffBlock> = {}): DiffBlock => ({ block_id: null, para_id: null, text, text_hash: textHash(text), kind: "paragraph", section: "4.2 Quality", ...extra })
const tableBlock = (rows: string[][], section: string): DiffBlock => block(rows.map((r) => r.join(" | ")).join("\n"), { kind: "table", rows, section })

describe("diffBlockLists với bảng và mục", () => {
  it("Record of Changes thêm 3 hàng ⇒ một entry bảng modified chỉ có 3 hàng added; không có entry removed / added cả bảng", () => {
    const old = [block("I. Record of Changes", { kind: "heading", section: "I. Record of Changes" }), tableBlock([ROC_HEADER, roc(1)], "I. Record of Changes"), block("Intro", { section: "1 Overview" })]
    const neu = [block("I. Record of Changes", { kind: "heading", section: "I. Record of Changes" }), tableBlock([ROC_HEADER, roc(1), roc(2), roc(3), roc(4)], "I. Record of Changes"), block("Intro", { section: "1 Overview" })]
    const res = diffBlockLists(old, neu)
    expect(res.blocks).toHaveLength(1)
    expect(res.blocks[0]).toMatchObject({ change: "modified", kind: "table", section: "I. Record of Changes" })
    expect(res.blocks[0].table!.rows.map((r) => r.change)).toEqual(["unchanged", "added", "added", "added"])
    expect(res.summary).toEqual({ added: 0, removed: 0, modified: 1, moved: 0 })
    expect(res.sections).toEqual([{ title: "I. Record of Changes", key: "I. Record of Changes", unchanged: 1 }, { title: "1 Overview", key: "1 Overview", unchanged: 1 }])
  })

  it("bảng có cột mã chỉ đảo hàng ⇒ không entry nào, tính là không đổi", () => {
    const res = diffBlockLists([tableBlock([reqHeader, ...reqs], "4.2 Quality")], [tableBlock([reqHeader, reqs[1], reqs[0], reqs[2]], "4.2 Quality")])
    expect(res.blocks).toEqual([])
    expect(res.sections).toEqual([{ title: "4.2 Quality", key: "4.2 Quality", unchanged: 1 }])
  })

  it("mục trùng tên ở hai chỗ (\"Luồng chính\" dưới hai UC) có khoá khác nhau, không bị gộp", () => {
    const sec = (uc: string, text: string) => block(text, { section: "Luồng chính", section_key: `3.2 > ${uc} > Luồng chính` })
    const res = diffBlockLists([sec("UC-01", "Bước một của đăng nhập hệ thống"), sec("UC-02", "Bước một của đăng ký tài khoản")], [sec("UC-01", "Bước một của đăng nhập hệ thống mới"), sec("UC-02", "Bước một của đăng ký tài khoản mới")])
    expect(res.blocks.map((b) => b.section_key)).toEqual(["3.2 > UC-01 > Luồng chính", "3.2 > UC-02 > Luồng chính"])
    expect(res.sections.map((s) => s.key)).toEqual(["3.2 > UC-01 > Luồng chính", "3.2 > UC-02 > Luồng chính"])
  })

  it("entry mang mục theo heading_path, đoạn sửa giữ before / after để FE tô chữ", () => {
    const res = diffBlockLists([block("The system shall respond within 2 seconds for search")], [block("The system shall respond within 1 seconds for search")])
    expect(res.blocks).toEqual([{ block_id: null, change: "modified", before: "The system shall respond within 2 seconds for search", after: "The system shall respond within 1 seconds for search", section: "4.2 Quality", kind: "paragraph" }])
  })
})
