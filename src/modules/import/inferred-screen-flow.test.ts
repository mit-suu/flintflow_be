/**
 * QLHS 11/11 bug #15: file upload chỉ ghi một chuyển màn (M2 → M3) ⇒ suy luồng Đăng nhập → màn của từng vai theo use case.
 */
import { describe, expect, it } from "vitest"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { resolveProvisional } from "./extracted-entities.js"
import { hasOwnScreenFlow, inferScreenFlow, inferredFlowFindings, inferredFlowOps, isSparseFlow, nameMatch } from "./inferred-screen-flow.js"

const SCREENS = [
  "Đăng nhập",
  "Danh sách học sinh",
  "Thêm / sửa hồ sơ học sinh",
  "Lớp học và phân lớp",
  "Điểm danh",
  "Nhập điểm",
  "Kết quả học tập",
  "Đánh giá hạnh kiểm",
  "Nhập từ Excel – xem trước",
  "Báo cáo thống kê"
]

const fn = (id: string, screenId: string | null) =>
  ({ id, screen_id: screenId, feature_id: "F1", order: 0, name: id, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }) as Spine["functions"][number]
const uc = (id: string, name: string, actor_ids: string[], function_ids: string[] = []) => ({ id, name, actor_ids, function_ids, description: "", includes: [], extends: [] })

/** QLHS: 10 màn "mỗi use case một màn", 5 vai, file chỉ ghi "nút Sửa mở M3". */
const qlhs = (): Spine => {
  const s = createEmptySpine()
  s.actors = [
    { id: "A1", name: "Quản trị viên", kind: "human", description: "" },
    { id: "A2", name: "Giáo viên chủ nhiệm", kind: "human", description: "" },
    { id: "A3", name: "Giáo viên bộ môn", kind: "human", description: "" },
    { id: "A4", name: "Giáo vụ", kind: "human", description: "" },
    { id: "A5", name: "Ban giám hiệu", kind: "human", description: "" },
    { id: "A6", name: "Hệ thống email", kind: "system", description: "" }
  ]
  s.screens = SCREENS.map((name, i) => ({
    id: `M${i + 1}`,
    feature_id: "F1",
    name,
    description: "",
    flow_to: i === 1 ? [{ to: "M3", trigger: "Sửa" }] : [],
    is_popup: false,
    tabs: [],
    primary_function_id: null,
    queue_order: i + 1,
    detail_status: "placeholder" as const
  }))
  s.functions = [fn("FN04", "M5"), fn("FN05", "M6")]
  s.use_cases = [
    uc("UC-01", "Đăng nhập", ["A1", "A2", "A3", "A4", "A5"]),
    uc("UC-02", "Thêm học sinh", ["A1", "A4"]),
    uc("UC-03", "Phân lớp học sinh", ["A4"]),
    uc("UC-04", "Điểm danh hằng ngày", ["A2", "A6"], ["FN04"]),
    uc("UC-05", "Nhập điểm môn học", ["A3"], ["FN05"]),
    uc("UC-06", "Xem kết quả học tập", ["A2", "A3", "A5"]),
    uc("UC-07", "Đánh giá hạnh kiểm", ["A2"]),
    uc("UC-08", "Nhập học sinh từ Excel", ["A4"]),
    uc("UC-09", "Báo cáo thống kê", ["A5"])
  ]
  return s
}

describe("nameMatch", () => {
  it("chứa trọn / phủ phần lớn ⇒ khớp; một từ chung ⇒ không", () => {
    expect(nameMatch("Điểm danh", "Điểm danh hằng ngày")?.[0]).toBe(1)
    expect(nameMatch("Nhập từ Excel – xem trước", "Nhập học sinh từ Excel")).not.toBeNull()
    expect(nameMatch("Nhập điểm", "Đăng nhập")).toBeNull()
    // khớp phần ("học sinh") thua màn chứa trọn tên use case
    expect(nameMatch("Danh sách học sinh", "Thêm học sinh")?.[0]).toBe(0)
    expect(nameMatch("Thêm / sửa hồ sơ học sinh", "Thêm học sinh")?.[0]).toBe(1)
    expect(nameMatch("M7 Kết quả học tập", "UC-06 Xem kết quả học tập")?.[0]).toBe(1)
  })
})

describe("inferScreenFlow (QLHS bug #15)", () => {
  it("Đăng nhập → màn của từng vai; màn có đường vào do file ghi (M3) đi qua M2", () => {
    const edges = inferScreenFlow(qlhs())
    expect(edges.map((e) => [e.from, e.to, e.trigger])).toEqual([
      ["M1", "M2", "Đăng nhập (Quản trị viên, Giáo vụ)"],
      ["M1", "M4", "Đăng nhập (Giáo vụ)"],
      ["M1", "M5", "Đăng nhập (Giáo viên chủ nhiệm)"],
      ["M1", "M6", "Đăng nhập (Giáo viên bộ môn)"],
      ["M1", "M7", "Đăng nhập (Giáo viên chủ nhiệm, Giáo viên bộ môn, Ban giám hiệu)"],
      ["M1", "M8", "Đăng nhập (Giáo viên chủ nhiệm)"],
      ["M1", "M9", "Đăng nhập (Giáo vụ)"],
      ["M1", "M10", "Đăng nhập (Ban giám hiệu)"]
    ])
  })

  it("cạnh suy ra áp được vào Spine, giữ cạnh file ghi; cờ Cần xem liệt kê cạnh theo tên màn", () => {
    const spine = qlhs()
    const edges = inferScreenFlow(spine)
    const planned = planTransaction(spine, { base_version: spine.spine_version, ops: inferredFlowOps(edges), by: "import", step_id: null }, { startSeq: 1 })
    const byId = new Map(planned.spine.screens.map((s) => [s.id, s]))
    expect(byId.get("M1")!.flow_to.map((e) => e.to)).toEqual(["M2", "M4", "M5", "M6", "M7", "M8", "M9", "M10"])
    expect(byId.get("M2")!.flow_to).toEqual([{ to: "M3", trigger: "Sửa" }])
    expect(isSparseFlow(planned.spine.screens)).toBe(false)
    expect(inferScreenFlow(planned.spine)).toEqual([])

    const [finding] = inferredFlowFindings(spine, edges)
    expect(finding.rule).toBe("needs_review")
    expect(finding.section_id).toBe("fixed:3.1.1")
    expect(finding.target_id).toBe("screens[id=M1].flow_to")
    expect(finding.message).toContain("Luồng màn hình suy từ use case và vai - cần xác nhận")
    expect(finding.message).toContain("Đăng nhập → Danh sách học sinh (Quản trị viên, Giáo vụ)")
    expect(finding.message).not.toMatch(/\bM\d+\b/)
  })

  it("không có màn đăng nhập / luồng file ghi đủ ⇒ không suy", () => {
    const noLogin = qlhs()
    noLogin.screens[0].name = "Trang chủ"
    noLogin.use_cases = noLogin.use_cases.filter((u) => u.id !== "UC-01")
    expect(inferScreenFlow(noLogin)).toEqual([])

    const dense = qlhs()
    for (let i = 0; i < 5; i++) dense.screens[i].flow_to = [{ to: dense.screens[i + 1].id }]
    expect(inferScreenFlow(dense)).toEqual([])
    expect(inferredFlowFindings(dense, [])).toEqual([])
  })

  it("màn đăng nhập nhận theo use case Đăng nhập; màn chưa nối use case ⇒ vai trong ma trận phân quyền; cạnh đã có không lặp", () => {
    const s = qlhs()
    s.screens[0].name = "Trang chào"
    s.functions.push(fn("FN01", "M1"))
    s.use_cases[0].function_ids = ["FN01"]
    s.use_cases = s.use_cases.filter((u) => u.id !== "UC-09")
    s.roles = [{ id: "R5", name: "BGH", actor_id: "A5" }]
    s.permissions = [{ id: "P1", screen_id: "M10", role_id: "R5", action: "view" }]
    s.screens[0].flow_to = [{ to: "M4" }]
    const edges = inferScreenFlow(s)
    expect(edges.find((e) => e.to === "M10")?.trigger).toBe("Trang chào (Ban giám hiệu)")
    expect(edges.some((e) => e.to === "M4")).toBe(false)
  })
})

describe("hasOwnScreenFlow", () => {
  const provisional = resolveProvisional([])
  it("ảnh sơ đồ luồng màn đọc được hoặc heading Screens Flow ⇒ có luồng riêng", () => {
    expect(hasOwnScreenFlow([{ diagram_images: [{ kind: "screen_flow" }] }] as never, [], provisional)).toBe(true)
    expect(hasOwnScreenFlow([], [{ section_id: "fixed:3.1.1" }], provisional)).toBe(true)
    expect(hasOwnScreenFlow([{ diagram_images: [{ kind: "usecase" }] }] as never, [{ section_id: "fixed:3.1" }], provisional)).toBe(false)
  })
})
