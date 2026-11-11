/** FLF-375: bảng của file upload giữ cột của khách khi CR thêm / sửa / xoá phần tử. */
import { describe, expect, it } from "vitest"
import { appendToFileTables, conformToFileTable } from "./file-table.js"
import type { Block, TableBlock } from "./rendered-document.types.js"

const cells = (row: string[]) => row.map((text) => [{ text }])
const table = (header: string[], rows: string[][]): TableBlock => ({ type: "table", header: cells(header), rows: rows.map(cells) })
const texts = (t: Block) => (t.type === "table" ? [t.header, ...t.rows].map((r) => r.map((c) => c.map((x) => x.text).join(""))) : [])

/** Bảng use case FlintFlow dựng cho UC-21 (6 cột mặc định). */
const flintflowUc21 = table(
  ["ID", "Use Case", "Actors", "Use Case Description", "Includes", "Extends"],
  [["UC-21", "Refer a Friend", "Customer", "Customer invites friends by sharing a referral link.", "", ""]]
)

describe("appendToFileTables", () => {
  it("use case mới ⇒ dòng mới của bảng use case trong file, đúng 4 cột của file", () => {
    const fileTable = table(["ID", "Use Case", "Actor", "Description"], [
      ["UC-19", "Sync Shipment Status", "Scheduler (System)", "System updates shipment status."],
      ["UC-20", "Auto-cancel Unpaid Orders", "Scheduler (System)", "System cancels unpaid orders."]
    ])
    const out: Block[] = [{ type: "paragraph", runs: [{ text: "Use cases:" }] }, fileTable]
    const left = appendToFileTables(out, [flintflowUc21], "fixed:2.2.1")
    expect(left).toEqual([])
    expect(out).toHaveLength(2)
    expect(texts(out[1])).toEqual([
      ["ID", "Use Case", "Actor", "Description"],
      ["UC-19", "Sync Shipment Status", "Scheduler (System)", "System updates shipment status."],
      ["UC-20", "Auto-cancel Unpaid Orders", "Scheduler (System)", "System cancels unpaid orders."],
      ["UC-21", "Refer a Friend", "Customer", "Customer invites friends by sharing a referral link."]
    ])
  })

  it("bảng có cột số thứ tự ⇒ đánh số tiếp", () => {
    const fileTable = table(["#", "Use case name", "Actor", "Description"], [["1", "Login", "Customer", "Sign in."], ["2", "Search", "Guest", "Find products."]])
    const out: Block[] = [fileTable]
    appendToFileTables(out, [flintflowUc21], "fixed:2.2.1")
    expect(texts(out[0])[3]).toEqual(["3", "Refer a Friend", "Customer", "Customer invites friends by sharing a referral link."])
  })

  it("không có bảng cùng loại phần tử ⇒ trả lại để in như cũ", () => {
    const actors = table(["#", "Actor", "Description"], [["1", "Guest", "A visitor."]])
    const out: Block[] = [actors]
    expect(appendToFileTables(out, [flintflowUc21], "fixed:2.2.1")).toEqual([flintflowUc21])
    expect(texts(out[0])).toHaveLength(2)
  })
})

describe("ma trận phân quyền", () => {
  const file = () => table(["Screen", "Guest", "Customer", "Store Admin"], [["Login", "X", "X", ""], ["Dashboard", "", "", "X"]])

  it("màn mới ⇒ dòng mới dùng ký hiệu của file; ô sẵn có không bị xoá", () => {
    const added = table(["Screen", "Guest", "Customer", "Sales Staff", "Store Admin"], [
      ["Login", "-", "-", "-", "-"],
      ["Dashboard", "-", "-", "-", "-"],
      ["Refer a Friend", "-", "access", "-", "-"]
    ])
    const out: Block[] = [file()]
    expect(appendToFileTables(out, [added], "fixed:3.1.3")).toEqual([])
    expect(texts(out[0])).toEqual([
      ["Screen", "Guest", "Customer", "Store Admin"],
      ["Login", "X", "X", ""],
      ["Dashboard", "", "", "X"],
      ["Refer a Friend", "", "X", ""]
    ])
  })

  it("quyền mới trên màn đã có ⇒ bật thêm ô, giữ ô cũ", () => {
    const added = table(["Screen", "Guest", "Customer", "Store Admin"], [["Dashboard", "-", "view", "-"]])
    const out: Block[] = [file()]
    appendToFileTables(out, [added], "fixed:3.1.3")
    expect(texts(out[0])[2]).toEqual(["Dashboard", "", "X", "X"])
  })
})

describe("conformToFileTable", () => {
  it("bảng dựng lại sau khi xoá một use case mang header + cột của file", () => {
    const fileRows = [["Mã UC", "Tên use case", "Tác nhân", "Mô tả"], ["UC-01", "Đăng nhập", "Giáo viên", "…"], ["UC-09", "Nhập Excel", "Giáo vụ", "…"]]
    const rebuilt = table(["ID", "Use Case", "Actors", "Use Case Description", "Includes", "Extends"], [["UC-01", "Đăng nhập", "Giáo viên", "Đăng nhập hệ thống.", "", ""]])
    expect(texts(conformToFileTable(rebuilt, fileRows, "fixed:2.2.1"))).toEqual([
      ["Mã UC", "Tên use case", "Tác nhân", "Mô tả"],
      ["UC-01", "Đăng nhập", "Giáo viên", "Đăng nhập hệ thống."]
    ])
  })
})
