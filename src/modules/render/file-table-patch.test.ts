import { describe, expect, it } from "vitest"
import {
  matchColumnOf,
  patchFileTableRows,
  patchPermissionMatrix,
  resolveFileTableColumns,
  sequenceColumnOf,
  type FileTableColumns,
  type PatchElement
} from "./file-table-patch.js"
import type { TableMapEntry } from "../import/template-profile.model.js"

const tableMapEntry = (block_id: string, column_index: number, field_path: string | null): TableMapEntry => ({
  block_id, column_index, field_path, header: "", confidence: 1, confirmed: true
})

describe("resolveFileTableColumns / matchColumnOf (FLF-468 lát B)", () => {
  it("ưu tiên table_map theo block_id — cả cột không có field (giữ nguyên khi vá)", () => {
    const tableMap = [
      tableMapEntry("b1", 0, "messages[].code"),
      tableMapEntry("b1", 1, "messages[].type"),
      tableMapEntry("b1", 2, "messages[].context"),
      tableMapEntry("b1", 3, "messages[].text"),
      tableMapEntry("b1", 4, null)
    ]
    const header = ["Mã", "Kiểu", "Ngữ cảnh", "Nội dung", "Chức năng"]
    const columns = resolveFileTableColumns([header], "fixed:5.3", "b1", tableMap)
    expect(columns).toEqual({ entity: "messages", fields: ["code", "type", "context", "text", null] })
    expect(matchColumnOf(columns!)).toBe(0)
  })

  it("không có table_map (bản ghi import cũ) ⇒ ghép theo từ điển tiêu đề", () => {
    const header = ["ID", "Rule"]
    const columns = resolveFileTableColumns([header, ["BR-01", "Only University accounts."]], "fixed:5.1", null, [])
    expect(columns).toEqual({ entity: "business_rules", fields: ["id", "statement"] })
  })

  it("sequenceColumnOf: cột '#' mọi ô thân là số ⇒ nhận; có chữ ⇒ không nhận", () => {
    expect(sequenceColumnOf(["#", "Content"], [["1", "a"], ["2", "b"]])).toBe(0)
    expect(sequenceColumnOf(["Code", "Content"], [["PAY-010", "a"]])).toBeNull()
  })
})

describe("patchFileTableRows (FLF-468 lát B)", () => {
  const columns: FileTableColumns = { entity: "messages", fields: ["code", "type", "context", "text", null] }
  const fileRows = [
    ["Mã", "Kiểu", "Ngữ cảnh", "Nội dung", "Chức năng"],
    ["CHAT-001", "Error", "Chat", "Không gửi được tin nhắn.", "Chat"],
    ["PAY-010", "Error", "Payment", "Không đủ số dư.", "Payment"],
    ["CHAT-002", "Warning", "Chat", "Tin nhắn quá dài.", "Chat"]
  ]
  const el = (matchValue: string, fields: PatchElement["fields"]): PatchElement => ({ matchValue, fields })

  it("sửa thông báo PAY-010 ⇒ đúng hàng PAY-010 đổi ô Nội dung, không thêm hàng, hàng khác giữ nguyên", () => {
    const current = [
      el("CHAT-001", { code: "CHAT-001", type: "Error", context: "Chat", text: "Không gửi được tin nhắn." }),
      el("PAY-010", { code: "PAY-010", type: "Error", context: "Payment", text: "Số dư không đủ để thanh toán." }),
      el("CHAT-002", { code: "CHAT-002", type: "Warning", context: "Chat", text: "Tin nhắn quá dài." })
    ]
    const result = patchFileTableRows({ fileRows, columns, current })
    expect(result.unmatched).toBe(false)
    expect(result.rows).toHaveLength(4) // header + 3, không thêm hàng
    expect(result.rows[2]).toEqual(["PAY-010", "Error", "Payment", "Số dư không đủ để thanh toán.", "Payment"])
    expect(result.rows[1]).toEqual(fileRows[1])
    expect(result.rows[3]).toEqual(fileRows[3])
  })

  it("xoá CHAT-001 (và CHAT-002) ⇒ mất đúng các hàng đó, PAY-010 còn nguyên", () => {
    const current = [el("PAY-010", { code: "PAY-010", type: "Error", context: "Payment", text: "Không đủ số dư." })]
    const result = patchFileTableRows({ fileRows, columns, current })
    expect(result.rows).toEqual([fileRows[0], fileRows[2]])
  })

  it("thêm thông báo mới ⇒ hàng mới cuối bảng, đủ ô Kiểu, cột không có field để trống", () => {
    const current = [
      el("CHAT-001", { code: "CHAT-001", type: "Error", context: "Chat", text: "Không gửi được tin nhắn." }),
      el("PAY-010", { code: "PAY-010", type: "Error", context: "Payment", text: "Không đủ số dư." }),
      el("CHAT-002", { code: "CHAT-002", type: "Warning", context: "Chat", text: "Tin nhắn quá dài." }),
      el("PAY-020", { code: "PAY-020", type: "Info", context: "Payment", text: "Giao dịch đang xử lý." })
    ]
    const result = patchFileTableRows({ fileRows, columns, current })
    expect(result.rows).toHaveLength(5)
    expect(result.rows[4]).toEqual(["PAY-020", "Info", "Payment", "Giao dịch đang xử lý.", ""])
  })

  it("bảng màn có cột Feature không field ⇒ Feature giữ nguyên khi sửa mô tả màn", () => {
    const screenColumns: FileTableColumns = { entity: "screens", fields: ["id", "name", null, "description"] }
    const screenRows = [
      ["ID", "Screen", "Feature", "Description"],
      ["SCR-01", "Login", "Account", "Màn đăng nhập."]
    ]
    const current = [el("SCR-01", { id: "SCR-01", name: "Login", description: "Màn đăng nhập bằng email." })]
    const result = patchFileTableRows({ fileRows: screenRows, columns: screenColumns, current })
    expect(result.rows[1]).toEqual(["SCR-01", "Login", "Account", "Màn đăng nhập bằng email."])
  })

  it("không có cột mã / tên để ghép ⇒ unmatched, giữ nguyên văn (\"Cần chốt\" #2)", () => {
    const noMatch: FileTableColumns = { entity: "common_requirements", fields: [null, "statement"] }
    const rows = [["Nhóm", "Nội dung"], ["Phân trang", "Lists paginate at 20."]]
    const result = patchFileTableRows({ fileRows: rows, columns: noMatch, current: [] })
    expect(result.unmatched).toBe(true)
    expect(result.rows).toEqual(rows)
  })
})

describe("patchPermissionMatrix (FLF-468 lát B)", () => {
  it("giữ dấu X cũ, chỉ thêm đúng một ô mới; màn đã xoá bỏ hàng, màn mới thêm hàng", () => {
    const fileRows = [
      ["Screen", "Admin", "Editor", "Viewer"],
      ["Dashboard", "X", "X", ""],
      ["Settings", "X", "", ""],
      ["Legacy Page", "X", "", ""]
    ]
    const current = new Map<string, ReadonlySet<string>>([
      ["Dashboard", new Set(["Admin", "Editor"])],
      // CR thêm quyền Editor cho Settings — chỉ ô này bật thêm, Admin vẫn giữ X cũ
      ["Settings", new Set(["Admin", "Editor"])],
      // Màn mới
      ["Reports", new Set(["Admin"])]
      // "Legacy Page" đã bị xoá khỏi Spine ⇒ không có trong current ⇒ hàng bị bỏ
    ])
    const result = patchPermissionMatrix({ fileRows, current })
    expect(result.rows).toEqual([
      ["Screen", "Admin", "Editor", "Viewer"],
      ["Dashboard", "X", "X", ""],
      ["Settings", "X", "X", ""],
      ["Reports", "X", "", ""]
    ])
  })
})
