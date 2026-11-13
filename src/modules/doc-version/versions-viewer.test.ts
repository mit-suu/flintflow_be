import { describe, expect, it } from "vitest"
import { blankInChargeColumn, compareForViewer } from "./versions.service.js"

const ROC = "Date | Version | A*, M, D | In charge | Change Description\n2026-11-13 | v0.1 | M | FlintFlow (import) | Import SRS\n2026-11-13 | v0.2 | M | Fixture User | CR-001: Update NFR-01"

describe("bản so sánh cho Viewer che cột In charge (UC-47 / UC-48)", () => {
  it("bảng Record of Changes: ô In charge của các dòng thân thành trống, tiêu đề và cột khác giữ nguyên", () => {
    expect(blankInChargeColumn(ROC)).toBe(
      "Date | Version | A*, M, D | In charge | Change Description\n2026-11-13 | v0.1 | M |  | Import SRS\n2026-11-13 | v0.2 | M |  | CR-001: Update NFR-01"
    )
  })

  it("bảng tiếng Việt (Người thực hiện) cũng che", () => {
    expect(blankInChargeColumn("Ngày | Phiên bản | A*, M, D | Người thực hiện | Mô tả thay đổi\n13/11 | 0.2 | M | Hoài Linh | CR-001")).not.toContain("Hoài Linh")
  })

  it("khối không phải bảng RoC giữ nguyên", () => {
    expect(blankInChargeColumn("Statement | Metric\nThe system shall respond | 1 s")).toBe("Statement | Metric\nThe system shall respond | 1 s")
    expect(blankInChargeColumn("Fixture User wrote this paragraph")).toBe("Fixture User wrote this paragraph")
  })

  it("compareForViewer áp cho cả before và after, khối thiếu một phía không thêm field", () => {
    const out = compareForViewer({
      from: "0.1",
      to: "0.2",
      summary: { added: 1, removed: 0, modified: 1, moved: 0 },
      blocks: [
        { block_id: null, change: "modified", before: ROC, after: ROC },
        { block_id: null, change: "added", after: "Version: 0.2" }
      ]
    })
    expect(JSON.stringify(out)).not.toContain("Fixture User")
    expect(out.blocks[1]).toEqual({ block_id: null, change: "added", after: "Version: 0.2" })
  })
})
