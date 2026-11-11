/** FLF-375: khi vẽ sơ đồ use case của tài liệu upload, không use case nào nối ≥ 2 actor người — dữ liệu file giữ nguyên. */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Spine } from "../../spine/spine.types.js"
import { DRAWN_USER_ID, drawnGeneralizations, withDrawnUser } from "./drawn-user.js"
import { renderUseCase } from "./usecase.renderer.js"

const triangles = (svg: string) => svg.match(/<polygon [^>]*fill="#fff"/g) ?? []

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

  it("TechMart 11/11: actor kế thừa actor khác cùng use case không tính là actor thứ hai ⇒ use case giữ cha (Guest), không thành User", () => {
    const s = qlhs()
    s.use_cases = s.use_cases.filter((u) => u.actor_ids.length < 2)
    s.actors.push(human("A06", "Khách") as never, human("A07", "Khách hàng", "A06") as never)
    s.use_cases.push(uc("UC-09", "Tìm sản phẩm", ["A06", "A07"]) as never)
    expect(withDrawnUser(s)).toBe(s)
  })

  it("TechMart 11/11: actor có cha trong file cùng đăng nhập với vai khác ⇒ chính nó kế thừa User (thêm cạnh chỉ trên hình), cha (Guest) không thành con User", () => {
    const s = qlhs()
    s.actors.push(human("A06", "Khách") as never, human("A07", "Khách hàng", "A06") as never)
    s.use_cases.push(uc("UC-09", "Tìm sản phẩm", ["A06", "A07"]) as never, uc("UC-10", "Đăng nhập cửa hàng", ["A07", "A04"]) as never)
    const drawn = withDrawnUser(s)
    expect(drawn.actors.find((a) => a.id === "A07")?.parent_id).toBe("A06")
    expect(drawn.actors.find((a) => a.id === "A06")?.parent_id ?? null).toBeNull()
    expect(drawnGeneralizations(drawn)).toContainEqual(["A07", DRAWN_USER_ID])
    expect(drawn.use_cases.find((u) => u.id === "UC-09")?.actor_ids).toEqual(["A06", "A07"])
    expect(drawn.use_cases.find((u) => u.id === "UC-10")?.actor_ids).toEqual([DRAWN_USER_ID])
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

describe("QLHS 11/11 bug #13: User có mũi tên kế thừa trên chính sơ đồ use case", () => {
  /** Mọi đầu tam giác rỗng (polygon nền trắng) trong SVG. */
  const lines = (svg: string) => [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map((m) => m.slice(1, 5).map(Number))
  /** Số nhánh ngang chạm thanh gom dọc của thân mang tam giác chung (= số actor con của User). */
  const generalizationCount = (svg: string): number => {
    const tip = triangles(svg)[0]!.match(/points="([^ ]+)/)![1].split(",").map(Number)
    const trunk = lines(svg).find(([, , x2, y2]) => x2 === tip[0] && y2 === tip[1])!
    return lines(svg).filter(([x1, y1, x2, y2]) => x2 === trunk[0] && y1 === y2 && x1 < x2).length
  }
  const overview = (s: Spine) => renderUseCase(s, null).find((p) => (p as { section?: string }).section === "fixed:2.2.1")!

  it("các vai trò được thay bằng User đều có cạnh generalization tới User, kể cả vai trò không còn use case riêng", () => {
    // TechMart 11/11 (user chốt): mỗi actor cha một hình — cạnh kế thừa nằm trên hình của User
    const parts = renderUseCase(qlhs(), null).filter((p) => (p as { section?: string }).section === "fixed:2.2.1")
    const part = parts.find((p) => String(p.source).includes(">User<"))!
    expect(part.issues).toEqual([])
    const svg = String(part.source)
    // A01, A02 không còn use case riêng (UC-01, UC-02 đều nối User) nhưng vẫn hiện để người đọc biết User là ai
    for (const name of ["Quản trị viên", "Giáo vụ", "GV chủ nhiệm", "Học sinh / Phụ huynh", "User"]) expect(svg).toContain(`>${name}<`)
    expect(triangles(svg)).toHaveLength(1) // một tam giác chung chạm User
    expect(generalizationCount(svg)).toBe(4) // 4 vai trò người; actor hệ thống (Máy chủ email) không kế thừa
  })

  it("không use case nào có ≥ 2 actor người ⇒ không User, không cạnh kế thừa", () => {
    const s = qlhs()
    s.use_cases = [uc("UC-07", "Gửi thông báo", ["A03", "A05"]) as never, uc("UC-08", "Tra cứu kết quả", ["A04"]) as never]
    const svg = String(overview(s).source)
    expect(svg).not.toContain(">User<")
    expect(triangles(svg)).toHaveLength(0)
  })

  it("dự án FlintFlow tự soạn ⇒ sơ đồ use case không vẽ generalization (vẫn ở hình phân cấp §2.1)", () => {
    const s = qlhs()
    s.custom_sections = []
    s.actors.push(human("A06", "Khách") as never, human("A07", "Khách hàng", "A06") as never)
    s.use_cases.push(uc("UC-09", "Mua hàng", ["A07"]) as never, uc("UC-10", "Xem hàng", ["A06"]) as never)
    const parts = renderUseCase(s, null)
    const useCaseSvg = parts.filter((p) => (p as { section?: string }).section === "fixed:2.2.1").map((p) => String(p.source)).join("")
    expect(triangles(useCaseSvg)).toHaveLength(0)
    expect(parts.some((p) => (p as { section?: string }).section === "fixed:2.1")).toBe(true)
  })
})

describe("FLF-375: sơ đồ use case tổng quát cho tài liệu upload", () => {
  it("không tách theo tính năng: một hình chính + một hình cho mỗi actor cha (User)", () => {
    const s = qlhs()
    s.features.push({ id: "F1", name: "Hồ sơ", order: 1 } as never, { id: "F2", name: "Thông báo", order: 2 } as never)
    s.functions.push({ id: "FR-01", feature_id: "F1" } as never, { id: "FR-02", feature_id: "F2" } as never)
    s.use_cases[1].function_ids = ["FR-01"]
    s.use_cases[2].function_ids = ["FR-02"]
    const parts = renderUseCase(s, null).filter((p) => (p as { section?: string }).section === "fixed:2.2.1")
    expect(parts).toHaveLength(2)
    // hình chính không có cạnh kế thừa; hình của User có
    expect(triangles(String(parts[0].source))).toHaveLength(0)
    expect(triangles(String(parts[1].source))).toHaveLength(1)
  })

  it("TechMart 11/11: actor cha có trong file (Guest) cũng có hình riêng, con (Customer) kế thừa trên hình đó; Customer kế thừa cả User trên hình User", () => {
    const s = qlhs()
    s.actors.push(human("A06", "Guest") as never, human("A07", "Customer", "A06") as never)
    s.use_cases.push(uc("UC-11", "Search Products", ["A06", "A07"]) as never, uc("UC-12", "Place Order", ["A07"]) as never, uc("UC-13", "Log In shop", ["A07", "A03"]) as never)
    const parts = renderUseCase(s, null).filter((p) => (p as { section?: string }).section === "fixed:2.2.1")
    const guest = parts.find((p) => /Search Products/.test(String(p.source)))!
    const user = parts.find((p) => /Log In shop/.test(String(p.source)))!
    const main = parts.find((p) => /Place Order/.test(String(p.source)))!
    expect(String(guest.source)).toContain(">Customer<")
    expect(triangles(String(guest.source))).toHaveLength(1)
    expect(String(user.source)).toContain(">Customer<")
    expect(triangles(String(main.source))).toHaveLength(0)
    expect(new Set([guest, user, main]).size).toBe(3)
    for (const p of parts) expect(p.issues).toEqual([])
  })
})
