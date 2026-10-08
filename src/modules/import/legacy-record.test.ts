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

  it("FLF-251: ô tiêu đề có xuống dòng (A*⏎M, D — SRS thật) vẫn nhận đủ cột khi đọc từ ô thật", () => {
    expect(recordRowsOfTable([["Date", "A*\nM, D", "In charge", "Change Description"], ["29/07/2026", "A", "QuynhTTN", "Added User Requirements"]])).toEqual([
      { date: "29/07/2026", version: "", change_type: "A", in_charge: "QuynhTTN", description: "Added User Requirements" }
    ])
  })

  it("FLF-252: hàng tên bảng gộp + cột nhận theo dữ liệu + Change Item gộp vào mô tả + bỏ dòng chú thích", () => {
    expect(
      recordRowsOfTable([
        ["RECORD OF CHANGES"],
        ["No", "Effective Date", "#", "Change Item", "Change Description", "Changed by"],
        ["1", "01/09/2026", "v1.0", "2.1 Actors", "Add Guest actor", "Hiep"],
        ["2", "05/09/2026", "v1.1", "", "Fix typos", "Anh"],
        ["*A - Added, M - Modified, D - Deleted"]
      ])
    ).toEqual([
      { date: "01/09/2026", version: "v1.0", change_type: "M", in_charge: "Hiep", description: "2.1 Actors: Add Guest actor" },
      { date: "05/09/2026", version: "v1.1", change_type: "M", in_charge: "Anh", description: "Fix typos" }
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
    // heading đầu là mục nội dung, không có heading Record of Changes ⇒ không lấy bảng nào sau nó
    expect(legacyRecordRows(blocks, new Map([["H1", "fixed:1"], ["H2", "fixed:1"]]))).toEqual([])
  })

  it("FLF-252: không có heading Record of Changes ⇒ bảng trông như bảng lịch sử trước mục nội dung đầu tiên", () => {
    const blocks = [
      { block_id: "T0", kind: "table", level: null, rows: [["Project Name", "Lumen"]] },
      { block_id: "T1", kind: "table", level: null, rows: [["Version", "Date", "Author", "Description"], ["0.1", "01/05", "Lan", "Initial draft"]] },
      { block_id: "H1", kind: "heading", level: 1 },
      { block_id: "T2", kind: "table", level: null, rows: [FPT_HEADER, ["x", "A", "y", "Không phải lịch sử"]] }
    ]
    expect(legacyRecordRows(blocks, new Map([["H1", "fixed:1"]]))).toEqual([
      { date: "01/05", version: "0.1", change_type: "M", in_charge: "Lan", description: "Initial draft" }
    ])
  })
})
