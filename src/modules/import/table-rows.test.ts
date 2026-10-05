import { describe, expect, it } from "vitest"
import { tableGrid, tableRows, tableText, type TableBlockLike } from "./table-rows.js"

const block = (kind: string, text: string, xml_path: string, rows?: string[][]): TableBlockLike => ({ kind, text, anchor: { xml_path }, ...(rows ? { rows } : {}) })

/** Bảng 3 hàng × 3 cột dạng block như parse sinh ra. */
const ucTable = (): TableBlockLike[] => {
  const rows = [
    ["Use Case ID", "Use Case Name", "Actor"],
    ["UC01", "Register account", "Learner, Admin"],
    ["UC-02", "Log in", "Learner"]
  ]
  return [
    block("table", rows.map((r) => r.join(" | ")).join("\n"), "body/tbl[0]"),
    ...rows.flatMap((r, ri) => r.map((c, ci) => block("table_cell", c, `body/tbl[0]/tr[${ri}]/tc[${ci}]/p[0]`)))
  ]
}

describe("tableGrid", () => {
  it("dựng lưới ô từ block table_cell, đoạn cùng ô nối xuống dòng, không lẫn bảng khác", () => {
    const blocks = [...ucTable(), block("table_cell", "dòng 2 của ô", "body/tbl[0]/tr[2]/tc[1]/p[1]"), block("table_cell", "bảng khác", "body/tbl[1]/tr[0]/tc[0]/p[0]")]
    expect(tableGrid(blocks[0], blocks)).toEqual([
      ["Use Case ID", "Use Case Name", "Actor"],
      ["UC01", "Register account", "Learner, Admin"],
      ["UC-02", "Log in\ndòng 2 của ô", "Learner"]
    ])
  })
})

describe("tableRows", () => {
  it("FLF-251: dùng rows đã lưu — ô tiêu đề có xuống dòng không làm gãy hàng như khi tách text", () => {
    const rows = [
      ["Date", "A*\nM, D", "In charge", "Change Description"],
      ["29/07/2026", "A", "QuynhTTN", "Added User Requirements"]
    ]
    const table = block("table", rows.map((r) => r.join(" | ")).join("\n"), "body/tbl[0]", rows)
    expect(tableRows(table, [table])).toEqual(rows)
    // cách cũ (tách text theo dòng) ra hàng tiêu đề gãy đôi
    expect(table.text.split("\n")[0].split(" | ")).toEqual(["Date", "A*"])
  })

  it("bản ghi cũ chưa có rows ⇒ dựng từ block ô", () => {
    const blocks = ucTable()
    expect(tableRows(blocks[0], blocks)[2]).toEqual(["UC-02", "Log in", "Learner"])
  })
})

describe("tableText", () => {
  it("mỗi hàng một dòng; xuống dòng trong ô ⇒ ' / '; dấu | trong ô không phá cột", () => {
    expect(
      tableText([
        ["#", "System Function", "Description"],
        ["1", "Meter & Deduct", "Type: Service\nTrigger: AI call | retry"]
      ])
    ).toBe("| # | System Function | Description |\n| 1 | Meter & Deduct | Type: Service / Trigger: AI call / retry |")
  })
})
