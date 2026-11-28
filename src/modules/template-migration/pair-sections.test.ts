import { describe, expect, it } from "vitest"
import { applyPairEdits, normalizeElementId, pairSections, PairEditError, type NewHeading, type OldHeading } from "./pair-sections.js"

const old = (key: string, heading_text: string, level: number, section_id = key): OldHeading => ({ key, heading_text, level, section_id })
const neu = (index: number, heading_text: string, section_id: string, extra: Partial<NewHeading> = {}): NewHeading => ({ key: `n${index}`, heading_text, section_id, ...extra })

const pairOf = (r: ReturnType<typeof pairSections>, key: string) => r.pairs.find((p) => p.old_key === key)!

describe("pairSections — mục khung theo section_id", () => {
  const oldDoc = [
    old("fixed:I", "I. Record of Changes", 1),
    old("fixed:1", "1 Product Overview", 1),
    old("group:2", "2 User Requirements", 1),
    old("fixed:2.1", "2.1 Actors", 2)
  ]

  it("đổi tên và đổi chỗ vẫn ghép đúng theo section_id", () => {
    const r = pairSections(oldDoc, [neu(0, "2.1 Actors and roles", "fixed:2.1"), neu(1, "2 User Requirements", "group:2"), neu(2, "1 Introduction", "fixed:1"), neu(3, "Revision History", "fixed:I")])
    expect(r.pairs.map((p) => [p.old_key, p.new_key, p.by])).toEqual([
      ["fixed:I", "n3", "section_id"],
      ["fixed:1", "n2", "section_id"],
      ["group:2", "n1", "section_id"],
      ["fixed:2.1", "n0", "section_id"]
    ])
  })

  it("mục khung không có ở mẫu đích ⇒ chưa ghép, không ghép chéo hai mục khung theo chữ", () => {
    // "Actors" (fixed:2.1) và heading "Actors" mang id khác (slot:context) là hai mục khung khác nhau
    const r = pairSections([old("fixed:2.1", "2.1 Actors", 2)], [neu(0, "Actors", "slot:context")])
    expect(pairOf(r, "fixed:2.1")).toMatchObject({ new_key: null, by: null })
  })

  it("mục đích có nhiều heading cùng section_id ⇒ ghép heading đầu, ghi split", () => {
    const r = pairSections([old("fixed:4.2.2", "4.2.2 Reliability", 3)], [neu(0, "Reliability", "fixed:4.2.2"), neu(1, "Availability", "fixed:4.2.2")])
    expect(pairOf(r, "fixed:4.2.2")).toMatchObject({ new_key: "n0", by: "section_id" })
    expect(r.split).toEqual([{ old_key: "fixed:4.2.2", new_keys: ["n0", "n1"] }])
  })

  it("mục FPT ghép với phần nhỏ slot chồng lấn (mẫu bắt buộc map heading vào slot)", () => {
    const r = pairSections([old("fixed:5.1", "5.1 Business Rules", 2), old("fixed:5.3", "5.3 Messages", 2)], [neu(0, "5.1 Business Rules", "slot:business_rules"), neu(1, "5.3 Messages", "slot:messages")])
    expect(r.pairs.map((p) => [p.old_key, p.new_key, p.by])).toEqual([["fixed:5.1", "n0", "overlap"], ["fixed:5.3", "n1", "overlap"]])
    expect(r.split).toEqual([])
  })

  it("một mục FPT chồng lấn nhiều phần nhỏ ⇒ ghép phần đầu, ghi split", () => {
    const r = pairSections([old("fixed:1", "1 Product Overview", 1)], [neu(0, "1.1 Purpose", "slot:vision"), neu(1, "1.2 Goals", "slot:goals")])
    expect(pairOf(r, "fixed:1")).toMatchObject({ new_key: "n0", by: "overlap" })
    expect(r.split).toEqual([{ old_key: "fixed:1", new_keys: ["n0", "n1"] }])
  })

  it("cờ auto_confirmed của mẫu ⇒ cặp hiện Cần xem", () => {
    const r = pairSections([old("fixed:1", "1 Product Overview", 1)], [neu(0, "Intro", "fixed:1", { auto_confirmed: true })])
    expect(pairOf(r, "fixed:1").needs_review).toBe(true)
  })
})

describe("pairSections — mục riêng theo chữ", () => {
  it("ghép theo titleSimilarity, bỏ số mục và chữ hoa thường", () => {
    const r = pairSections([old("custom:c1", "5.9 Team Notes", 2), old("custom:c2", "9 Operating Environment", 1)], [neu(0, "6 operating environment", "unmapped"), neu(1, "Team notes", "unmapped")])
    expect(pairOf(r, "custom:c1")).toMatchObject({ new_key: "n1", by: "title", needs_review: false })
    expect(pairOf(r, "custom:c2")).toMatchObject({ new_key: "n0", by: "title" })
  })

  it("dưới ngưỡng ⇒ để chưa ghép", () => {
    const r = pairSections([old("custom:c1", "Lumen Integration", 1)], [neu(0, "Security Requirements", "unmapped")])
    expect(pairOf(r, "custom:c1")).toMatchObject({ new_key: null })
  })

  it("mỗi mục mới chỉ ghép một mục cũ (điểm cao nhất thắng)", () => {
    const r = pairSections([old("custom:c1", "Operating Environment", 1), old("custom:c2", "Operating Environment Notes", 1)], [neu(0, "Operating Environment", "unmapped")])
    expect(pairOf(r, "custom:c1").new_key).toBe("n0")
    expect(pairOf(r, "custom:c2").new_key).toBeNull()
  })

  it("mục khung chưa ghép được ghép theo chữ với mục riêng của mẫu đích", () => {
    const r = pairSections([old("fixed:5.5", "5.5 Glossary", 2)], [neu(0, "Glossary of terms", "unmapped")])
    expect(pairOf(r, "fixed:5.5")).toMatchObject({ new_key: "n0", by: "title" })
  })

  it("cùng đầu vào ⇒ cùng kết quả", () => {
    const oldDoc = [old("custom:c1", "Operating Environment", 1), old("custom:c2", "Operating Environment", 1)]
    const newDoc = [neu(0, "Operating Environment", "unmapped"), neu(1, "Operating Environment", "unmapped")]
    expect(pairSections(oldDoc, newDoc)).toEqual(pairSections(oldDoc, newDoc))
  })
})

describe("pairSections — phần tử đi theo mục khung cha", () => {
  const oldDoc = [
    old("group:3", "3 Functional Requirements", 1),
    old("fixed:3.1.2", "3.1.2 Screen Description", 3),
    old("custom:c9", "SCR-01 Login screen", 4),
    old("feature:F01", "3.2 Authentication", 2),
    old("function:FN01", "3.2.1 Register account", 3),
    old("custom:c1", "", 4),
    old("custom:c2", "5.9 Team Notes", 2)
  ]

  it("feature / function / mục riêng lồng dưới mục chứa phần tử không vào danh sách ghép", () => {
    const r = pairSections(oldDoc, [neu(0, "3 Functional Requirements", "group:3"), neu(1, "3.1.2 Screen Description", "fixed:3.1.2")])
    expect(r.pairs.map((p) => p.old_key)).toEqual(["group:3", "fixed:3.1.2", "custom:c2"])
    expect(r.followers).toEqual([
      { old_key: "custom:c9", kind: "element", parent_old_key: "fixed:3.1.2" },
      { old_key: "feature:F01", kind: "element", parent_old_key: "group:3" },
      { old_key: "function:FN01", kind: "element", parent_old_key: "group:3" },
      { old_key: "custom:c1", kind: "continuation", parent_old_key: "group:3" }
    ])
  })

  it("heading phần tử của mẫu đích chỉ là ví dụ ⇒ bỏ qua, không thành mục thiếu", () => {
    const r = pairSections(oldDoc, [neu(0, "3 Functional Requirements", "group:3"), neu(1, "3.2 Feature name", "feature:@B0100"), neu(2, "3.2.1 Function name", "function:@B0101")])
    expect(r.ignored_new).toEqual(["n1", "n2"])
  })

  it("nhận phần tử theo tên / mã trong Spine dù heading không có id feature / function", () => {
    const r = pairSections(
      [old("fixed:2.2.2", "2.2.2 Use Case Descriptions", 3), old("custom:a", "UC-07 Approve loan", 2), old("custom:b", "Approve loan limit", 2), old("custom:c", "Notes", 2)],
      [neu(0, "2.2.2 Descriptions", "fixed:2.2.2")],
      { elementIds: new Set([normalizeElementId("UC07")]), elementNames: new Set(["approve loan limit"]) }
    )
    expect(r.followers.filter((f) => f.kind === "element").map((f) => f.old_key)).toEqual(["custom:a", "custom:b"])
    expect(r.pairs.map((p) => p.old_key)).toEqual(["fixed:2.2.2", "custom:c"])
  })
})

describe("applyPairEdits", () => {
  const oldDoc = [old("custom:c1", "Notes", 1), old("custom:c2", "Environment", 1)]
  const newDoc = [neu(0, "Alpha", "unmapped"), neu(1, "Beta", "unmapped"), neu(2, "Feature", "feature:@B0001")]
  const base = pairSections(oldDoc, newDoc)

  it("sửa tay ⇒ by manual; bỏ ghép ⇒ null", () => {
    const r = applyPairEdits(base, newDoc, [{ old_key: "custom:c1", new_key: "n1" }, { old_key: "custom:c2", new_key: null }])
    expect(pairOf(r, "custom:c1")).toMatchObject({ new_key: "n1", by: "manual", needs_review: false })
    expect(pairOf(r, "custom:c2")).toMatchObject({ new_key: null, by: null })
  })

  it.each([
    ["old_key lạ", [{ old_key: "custom:zzz", new_key: "n0" }]],
    ["new_key lạ", [{ old_key: "custom:c1", new_key: "n99" }]],
    ["new_key là heading phần tử của mẫu", [{ old_key: "custom:c1", new_key: "n2" }]],
    ["một mục mới cho hai mục cũ", [{ old_key: "custom:c1", new_key: "n0" }, { old_key: "custom:c2", new_key: "n0" }]],
    ["sửa một mục hai lần", [{ old_key: "custom:c1", new_key: "n0" }, { old_key: "custom:c1", new_key: "n1" }]]
  ])("từ chối: %s", (_label, edits) => {
    expect(() => applyPairEdits(base, newDoc, edits)).toThrow(PairEditError)
  })
})

describe("pairSections — FLF-491: mục chương 1 và 4.2.4 theo danh mục, heading con đi theo mục cha", () => {
  const oldDoc = [
    old("custom:CS01", "1 Tổng quan sản phẩm", 1),
    old("slot:goals", "Mục tiêu", 2),
    old("slot:scope", "Phạm vi phát hành 1.0", 2),
    old("fixed:1", "Quy tắc nghiệp vụ tổng quát", 2),
    old("custom:CS04", "Hệ thống bên ngoài", 2),
    old("fixed:4.2.4", "4.2.4 Thuộc tính đặc thù", 3),
    old("fixed:5.5", "5.5 Thuật ngữ", 2)
  ]
  const target = [neu(0, "1. Product Overview", "fixed:1", { level: 2 }), neu(1, "4.2.4 …", "unmapped", { level: 3 })]

  it("mục cha ghép theo danh mục (Cần xem), bốn mục con là follower child, 4.2.4 ghép, chỉ Thuật ngữ chưa ghép", () => {
    const r = pairSections(oldDoc, target)
    expect(pairOf(r, "custom:CS01")).toMatchObject({ new_key: "n0", by: "title", needs_review: true })
    expect(r.followers.filter((f) => f.kind === "child").map((f) => [f.old_key, f.parent_old_key])).toEqual([
      ["slot:goals", "custom:CS01"],
      ["slot:scope", "custom:CS01"],
      ["fixed:1", "custom:CS01"],
      ["custom:CS04", "custom:CS01"]
    ])
    expect(pairOf(r, "fixed:4.2.4")).toMatchObject({ new_key: "n1", needs_review: true })
    expect(pairOf(r, "fixed:5.5")).toMatchObject({ new_key: null })
    expect(r.pairs.map((p) => p.old_key)).toEqual(["custom:CS01", "fixed:4.2.4", "fixed:5.5"])
  })

  it("mẫu đích có heading con tương ứng ⇒ mục con ghép heading con đó, không thành child", () => {
    const r = pairSections(oldDoc, [neu(0, "1. Product Overview", "fixed:1", { level: 2 }), neu(1, "1.1 Goals", "slot:goals", { level: 3 })])
    expect(pairOf(r, "slot:goals")).toMatchObject({ new_key: "n1" })
    expect(r.followers.find((f) => f.old_key === "slot:goals")).toBeUndefined()
    // "Hệ thống bên ngoài" không có chỗ riêng nhưng cây con của chương 1 đã hết heading chưa có chủ ⇒ vẫn theo mục cha
    expect(r.followers.find((f) => f.old_key === "custom:CS04")).toMatchObject({ kind: "child" })
  })

  it("mẫu đích có heading con chưa có chủ ⇒ mục riêng tên lạ vẫn là mục thừa", () => {
    const r = pairSections(oldDoc, [neu(0, "1. Product Overview", "fixed:1", { level: 2 }), neu(1, "1.1 Vision", "unmapped", { level: 3 })])
    expect(r.followers.find((f) => f.old_key === "custom:CS04")).toBeUndefined()
    expect(pairOf(r, "custom:CS04")).toMatchObject({ new_key: null })
  })
})

describe("pairSections — heading nhóm có mục con của mẫu đích không nhận id khung theo danh mục", () => {
  it("'1. Giới thiệu' (bí danh của Tổng quan) không giành mục cũ của mục con thật '2.1 Góc nhìn sản phẩm'", () => {
    const r = pairSections(
      [old("fixed:1", "Quy tắc nghiệp vụ tổng quát", 2)],
      [neu(0, "1. Giới thiệu", "unmapped", { level: 1 }), neu(1, "1.1 Mục đích tài liệu", "slot:vision", { level: 2 }), neu(2, "2. Tổng quan sản phẩm", "unmapped", { level: 1 }), neu(3, "2.1 Góc nhìn sản phẩm", "fixed:1", { level: 2 })]
    )
    expect(pairOf(r, "fixed:1").new_key).toBe("n3")
    expect(r.split).toEqual([])
  })
})
