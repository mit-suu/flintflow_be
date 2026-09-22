/**
 * T15 (mode 1 v3): đọc Record of Changes của file gốc — bảng dưới heading khớp `fixed:I` ⇒ dòng `RocRow`.
 */
import { describe, expect, it } from "vitest"
import { legacyRecordRows, recordRowsOfTable } from "./legacy-record.js"

const FPT_HEADER = ["Date", "A*, M, D", "In charge", "Change Description"]

describe("recordRowsOfTable", () => {
  it("bảng mẫu FPT: nhận cột theo tiêu đề, loại thay đổi chuẩn hoá A/M/D, bỏ dòng trống", () => {
    expect(
      recordRowsOfTable([FPT_HEADER, ["01/05/2026", "A", "Nhóm 1", "Create and edit Product Overview"], ["", "", "", ""], ["05/05/2026", "modified", "An", "Add and modified Requirement Appendix"]])
    ).toEqual([
      { date: "01/05/2026", version: "", change_type: "A", in_charge: "Nhóm 1", description: "Create and edit Product Overview" },
      { date: "05/05/2026", version: "", change_type: "M", in_charge: "An", description: "Add and modified Requirement Appendix" }
    ])
  })

  it("tiêu đề tiếng Việt + cột phiên bản", () => {
    expect(recordRowsOfTable([["Ngày", "Phiên bản", "Loại", "Người thực hiện", "Mô tả"], ["1/6", "0.2", "D", "Lan", "Bỏ mục cũ"]])).toEqual([
      { date: "1/6", version: "0.2", change_type: "D", in_charge: "Lan", description: "Bỏ mục cũ" }
    ])
  })

  it("bảng không có cột mô tả ⇒ không phải bảng lịch sử ⇒ rỗng", () => {
    expect(recordRowsOfTable([["Actor", "Role"], ["Admin", "Quản trị"]])).toEqual([])
    expect(recordRowsOfTable([])).toEqual([])
  })
})

describe("legacyRecordRows", () => {
  it("chỉ lấy bảng nằm dưới heading Record of Changes (tới heading cùng cấp kế tiếp)", () => {
    const blocks = [
      { block_id: "H1", kind: "heading", level: 1 },
      { block_id: "T1", kind: "table", level: null, rows: [FPT_HEADER, ["01/05", "A", "Nhóm 1", "Tạo tài liệu"]] },
      { block_id: "H2", kind: "heading", level: 1 },
      { block_id: "T2", kind: "table", level: null, rows: [FPT_HEADER, ["x", "A", "y", "Không phải lịch sử"]] }
    ]
    const map = new Map([
      ["H1", "fixed:I"],
      ["H2", "fixed:1"]
    ])
    expect(legacyRecordRows(blocks, map).map((r) => r.description)).toEqual(["Tạo tài liệu"])
    expect(legacyRecordRows(blocks, new Map())).toEqual([])
  })
})
