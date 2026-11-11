/** FLF-375: khi vẽ sơ đồ use case của tài liệu upload, không use case nào nối ≥ 2 actor người — dữ liệu file giữ nguyên. */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Spine } from "../../spine/spine.types.js"
import { DRAWN_USER_ID, withDrawnUser } from "./drawn-user.js"
import { renderUseCase } from "./usecase.renderer.js"

const uc = (id: string, name: string, actor_ids: string[]) => ({ id, name, actor_ids, function_ids: [], description: "", includes: [], extends: [] })
const human = (id: string, name: string, parent_id: string | null = null) => ({ id, name, kind: "human", description: "", parent_id })

const qlhs = (): Spine => {
  const s = createEmptySpine({ name: "QLHS" })
  // Dự án upload: có mục nguyên văn của file
  s.custom_sections.push({ id: "CS01", heading: "", level: 2, source: "import", blocks: [] } as never)
  s.actors.push(
    human("A01", "Quản trị viên") as never,
    human("A02", "Giáo vụ") as never,
    human("A03", "GV chủ nhiệm") as never,
    human("A04", "Học sinh / Phụ huynh") as never,
    { id: "A05", name: "Máy chủ email", kind: "system", description: "", parent_id: null } as never
  )
  s.use_cases.push(
    uc("UC-01", "Đăng nhập", ["A01", "A02", "A03", "A04"]) as never,
    uc("UC-02", "Quản lý hồ sơ học sinh", ["A01", "A02", "A03"]) as never,
    uc("UC-07", "Gửi thông báo", ["A03", "A05"]) as never,
    uc("UC-08", "Tra cứu kết quả", ["A04"]) as never
  )
  return s
}

describe("withDrawnUser", () => {
  it("mọi use case có ≥ 2 actor người (không chỉ đăng nhập) ⇒ nối User, các actor đó kế thừa User; Spine gốc không đổi", () => {
    const source = qlhs()
    const before = structuredClone(source)
    const drawn = withDrawnUser(source)
    expect(source).toEqual(before)
    expect(drawn.actors.find((a) => a.id === DRAWN_USER_ID)).toMatchObject({ name: "User", kind: "human" })
    expect(drawn.actors.filter((a) => a.parent_id === DRAWN_USER_ID).map((a) => a.name)).toEqual(["Quản trị viên", "Giáo vụ", "GV chủ nhiệm", "Học sinh / Phụ huynh"])
    const ids = (id: string) => drawn.use_cases.find((u) => u.id === id)?.actor_ids
    expect(ids("UC-01")).toEqual([DRAWN_USER_ID])
    expect(ids("UC-02")).toEqual([DRAWN_USER_ID])
    // Một actor người + actor hệ thống ⇒ giữ nguyên; một actor ⇒ giữ nguyên
    expect(ids("UC-07")).toEqual(["A03", "A05"])
    expect(ids("UC-08")).toEqual(["A04"])
    // Không use case nào trên hình còn ≥ 2 actor người
    const humanIds = new Set(drawn.actors.filter((a) => a.kind === "human").map((a) => a.id))
    expect(drawn.use_cases.every((u) => u.actor_ids.filter((id) => humanIds.has(id)).length <= 1)).toBe(true)
  })

  it("actor đã có cha trong file (Customer kế thừa Guest) ⇒ gốc của nó (Guest) kế thừa User, Customer giữ cha", () => {
    const s = qlhs()
    s.actors.push(human("A06", "Khách") as never, human("A07", "Khách hàng", "A06") as never)
    s.use_cases.push(uc("UC-09", "Tìm sản phẩm", ["A06", "A07"]) as never)
    const drawn = withDrawnUser(s)
    expect(drawn.actors.find((a) => a.id === "A07")?.parent_id).toBe("A06")
    expect(drawn.actors.find((a) => a.id === "A06")?.parent_id).toBe(DRAWN_USER_ID)
  })

  it("không use case nào có ≥ 2 actor người ⇒ không đổi gì", () => {
    const s = qlhs()
    s.use_cases = [uc("UC-08", "Tra cứu kết quả", ["A04"]) as never]
    expect(withDrawnUser(s)).toBe(s)
  })

  it("dự án FlintFlow tự soạn (không có mục của file) ⇒ không đổi gì khi vẽ", () => {
    const s = qlhs()
    s.custom_sections = []
    expect(withDrawnUser(s)).toBe(s)
  })

  it("Spine đã có actor User ⇒ dùng chính actor đó", () => {
    const s = qlhs()
    s.actors.push(human("A09", "User") as never)
    const drawn = withDrawnUser(s)
    expect(drawn.actors.some((a) => a.id === DRAWN_USER_ID)).toBe(false)
    expect(drawn.use_cases[0].actor_ids).toEqual(["A09"])
  })

  it("sơ đồ vẽ ra có User", () => {
    const svg = renderUseCase(qlhs(), null)
      .map((p) => String((p as { source?: string }).source ?? ""))
      .join("\n")
    expect(svg).toContain(">User<")
  })
})

describe("FLF-375: sơ đồ use case tổng quát cho tài liệu upload", () => {
  it("≤ 20 use case ⇒ một hình duy nhất (không tách theo tính năng)", () => {
    const s = qlhs()
    s.features.push({ id: "F1", name: "Hồ sơ", order: 1 } as never, { id: "F2", name: "Thông báo", order: 2 } as never)
    s.functions.push({ id: "FR-01", feature_id: "F1" } as never, { id: "FR-02", feature_id: "F2" } as never)
    s.use_cases[1].function_ids = ["FR-01"]
    s.use_cases[2].function_ids = ["FR-02"]
    const parts = renderUseCase(s, null).filter((p) => (p as { section?: string }).section === "fixed:2.2.1")
    expect(parts).toHaveLength(1)
  })
})
