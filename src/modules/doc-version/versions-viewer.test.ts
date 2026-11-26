import { describe, expect, it, vi } from "vitest"
import { projectCode } from "../project/project-code.js"
import { blankInChargeColumn, compareWithoutAuthors, listVersions, toVersionDto } from "./versions.service.js"

const doc = (version: string, kind: string, based_on: string | null, cr_ids: string[] = []) =>
  ({ projectId: "p1", version, kind, based_on, cr_ids, createdAt: new Date("2026-11-01"), created_by: "u1" }) as never
const mockList = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock("./doc-version.service.js", async (orig) => ({ ...(await orig<object>()), listDocVersions: async () => mockList.items }))

const ROC = "Date | Version | A*, M, D | In charge | Change Description\n2026-11-13 | v0.1 | M | FlintFlow (import) | Import SRS\n2026-11-13 | v0.2 | M | Fixture User | CR-001: Update NFR-01"

describe("bản so sánh che cột In charge cho mọi vai trò (UC-47 / UC-48)", () => {
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

  it("compareWithoutAuthors áp cho cả before và after, khối thiếu một phía không thêm field", () => {
    const out = compareWithoutAuthors({
      from: "0.1",
      to: "0.2",
      summary: { added: 1, removed: 0, modified: 1, moved: 0 },
      blocks: [
        { block_id: null, change: "modified", before: ROC, after: ROC },
        { block_id: null, change: "added", after: "Version: 0.2" }
      ],
      sections: []
    })
    expect(JSON.stringify(out)).not.toContain("Fixture User")
    expect(out.blocks[1]).toEqual({ block_id: null, change: "added", after: "Version: 0.2" })
  })
})

describe("Viewer chỉ thấy bản ổn định (FLF-466, BF §2)", () => {
  it("listVersions cho Viewer bỏ bản nháp, ẩn mã CR, based_on trỏ bản ổn định liền trước", async () => {
    mockList.items = [doc("2.0", "release", "1.2", ["CR-002"]), doc("1.2", "cr_revision", "1.1", ["CR-002"]), doc("1.1", "cr_revision", "1.0", ["CR-001"]), doc("1.0", "release", "0.1", ["CR-001"]), doc("0.1", "imported", null)]
    const project = { converted_from: null } as never
    const viewer = await listVersions("p1", project, { viewer: true })
    expect(viewer.map((v) => [v.version, v.based_on, v.cr_ids])).toEqual([["2.0", "1.0", []], ["1.0", "0.1", []], ["0.1", null, []]])
    expect(viewer.every((v) => v.project_code === projectCode("p1"))).toBe(true)
    const lead = await listVersions("p1", project)
    expect(lead.map((v) => v.version)).toEqual(["2.0", "1.2", "1.1", "1.0", "0.1"])
    expect(lead.every((v) => v.project_code === projectCode("p1"))).toBe(true)
  })
})

describe("other_language_available (FLF-466 phase 07)", () => {
  it("mọi version có Spine của mình (baseline hoặc spine_snapshot) tải được ngôn ngữ còn lại, kể cả dự án upload thật; bản nháp cũ không snapshot thì không", () => {
    const project = { mode: "import", converted_from: null } as never
    const dto = (extra: object) => toVersionDto({ ...(doc("1.1", "cr_revision", "1.0", ["CR-001"]) as object), cr_ids: [], ...extra } as never, project)
    expect(dto({ baseline_ref: "650000000000000000000077" }).other_language_available).toBe(true)
    expect(dto({ spine_snapshot: { actors: [] } }).other_language_available).toBe(true)
    expect(dto({ baseline_ref: null, spine_snapshot: null }).other_language_available).toBe(false)
  })
})
