import { describe, expect, it } from "vitest"
import { planLayout } from "./build-base-file.js"
import { classify, withSuggestedDecisions } from "./classify.js"
import { CHOVIET_DATA, CHOVIET_HEADINGS, JAM01_FILLED_FROM_SPINE, JAM01_HEADINGS } from "./choviet-jam01.fixture.js"
import { buildOutline } from "./outline.js"
import { pairSections } from "./pair-sections.js"

/** Đổi mẫu ChoViet ⇒ jam01 với mọi gợi ý (kể cả dòng đoán đã được BA xác nhận). */
const setup = () => {
  const pairing = pairSections(CHOVIET_HEADINGS, JAM01_HEADINGS)
  // jam01 có bảng "Lịch sử sửa đổi" ở trang đầu, trước heading đầu tiên
  const newTables = new Map([["fixed:I", [{ columns: ["roc:in_charge", "roc:date", "roc:description", "roc:version"], headers: ["Người thực hiện", "Ngày", "Lý do thay đổi", "Phiên bản"] }]]])
  const groups = classify({ old: CHOVIET_HEADINGS, neu: JAM01_HEADINGS, pairing, oldData: CHOVIET_DATA, newFilled: JAM01_FILLED_FROM_SPINE, newTables, preHeadingRecord: true })
  const confirmed = [...groups.extra, ...groups.conflict].filter((i) => i.confidence === "guess" && i.suggested).map((i) => ({ id: i.id, choice: i.suggested! }))
  const decisions = withSuggestedDecisions(groups, confirmed, (id, choice) => ({ id, choice }))
  const input = { targetHeadings: JAM01_HEADINGS, oldHeadings: CHOVIET_HEADINGS, pairing, groups, decisions, hasSpineElements: true }
  let n = 0
  return { pairing, groups, decisions, input, layout: planLayout(input, () => `L${n++}`) }
}

describe("planLayout — golden ChoViet ⇒ jam01", () => {
  const { layout } = setup()
  const row = (text: string) => layout.entries.find((e) => e.heading_text === text)
  const order = (text: string) => layout.entries.findIndex((e) => e.heading_text === text)

  it("3.2 Chức năng: nhóm chức năng đánh số 3.2.1…, chức năng 3.2.x.y, rồi 3 phần gộp theo thứ tự tài liệu cũ", () => {
    expect(row("3.2.1 Tài khoản và truy cập")).toMatchObject({ level: 3, kind: "follower" })
    expect(row("3.2.1.1 Đăng nhập")).toMatchObject({ level: 4 })
    const parts = ["3.2.7 Đặc tả use case", "3.2.8 Chức năng không có màn hình", "3.2.9 Quy tắc nghiệp vụ"]
    for (const p of parts) expect(row(p)).toMatchObject({ level: 3, kind: "moved" })
    expect(order("3.2.6 Quản trị nền tảng")).toBeLessThan(order(parts[0]))
    expect(parts.map(order)).toEqual([...parts.map(order)].sort((a, b) => a - b))
  })

  it("không có hai heading cùng số; mọi heading dưới 3.2 bắt đầu bằng 3.2.", () => {
    const numbers = layout.entries.map((e) => /^(\d+(\.\d+)*)\s/.exec(e.heading_text)?.[1]).filter((x): x is string => !!x)
    expect(new Set(numbers).size).toBe(numbers.length)
    const from = order("3.2 Chức năng")
    const to = order("3.3 Chất lượng dịch vụ")
    for (const e of layout.entries.slice(from + 1, to)) if (/^\d/.test(e.heading_text)) expect(e.heading_text.startsWith("3.2.")).toBe(true)
  })

  it("gộp vào heading nhóm ⇒ mục con mới cuối nhóm (3.3.6); gộp vào mục đã có cặp ⇒ cấp + 1 sau phần tử của cặp", () => {
    expect(row("3.3.6 Tính khả dụng")).toMatchObject({ level: 3, kind: "moved" })
    expect(order("3.3.5 Khả năng quan sát")).toBeLessThan(order("3.3.6 Tính khả dụng"))
    expect(row("Mục tiêu")).toMatchObject({ level: 3, kind: "moved" })
    expect(order("Ngoài phạm vi")).toBeLessThan(order("Mục tiêu"))
    expect(row("3.1.1.1 Luồng màn hình")).toMatchObject({ level: 4 })
    expect(row("5.1 Sơ đồ quan hệ thực thể")).toMatchObject({ level: 2 })
    expect(row("5.2 Danh sách thông báo")).toMatchObject({ level: 2 })
  })

  it("mục in từ Spine không còn là mục thiếu; Yêu cầu khác không in lần hai (đã in ở 2.5 từ Spine), 3.4 không nhận rủi ro", () => {
    expect(row("1.1 Mục đích tài liệu")).toMatchObject({ missing: false, from_spine: true })
    expect(row("2.5 Giả định và phụ thuộc")).toMatchObject({ missing: false, from_spine: true })
    expect(layout.entries.some((e) => e.heading_text.includes("Yêu cầu khác"))).toBe(false)
    expect(row("3.4 Tuân thủ")?.old_key).toBeNull()
  })

  it("Độ tin cậy chia theo phần tử: 3.3.4 là mục riêng có lát NFR-06, 3.3.3 giữ mục 4.2.2", () => {
    expect(row("3.3.3 Độ tin cậy")).toMatchObject({ section_id: "fixed:4.2.2", items: ["NFR-05"] })
    const availability = row("3.3.4 Tính sẵn sàng")!
    expect(availability.section_id).toMatch(/^custom:/)
    expect(layout.slices).toEqual([{ custom_id: availability.section_id.slice("custom:".length), section_id: "fixed:4.2.2", items: ["nfrs:NFR-06"] }])
    expect(layout.newCustoms.map((c) => c.section_id)).toContain(availability.section_id)
  })

  it("bảng chữ cũ ⇒ chữ mới để sửa tham chiếu chéo", () => {
    expect(layout.renumbered.get("3.2 Tài khoản và truy cập")).toBe("3.2.1 Tài khoản và truy cập")
  })
})

describe("buildOutline đọc từ kế hoạch", () => {
  const { pairing, groups, decisions, layout } = setup()
  const outline = buildOutline({ old: CHOVIET_HEADINGS, neu: JAM01_HEADINGS, pairing, groups, decisions, spine: { custom_sections: [], functions: [{}] } as never })

  it("dãy heading (chữ + cấp) của dàn tiêu đề = layout (bỏ heading phần tử, dòng không in, dòng gộp vào mục cha)", () => {
    const fromOutline = outline.filter((e) => e.status !== "dropped" && e.merged_into === undefined).map((e) => [e.heading_text, e.level])
    const fromLayout = layout.entries.filter((e) => e.kind !== "follower" && e.heading_text.trim()).map((e) => [e.heading_text, e.level])
    expect(fromOutline).toEqual(fromLayout)
  })

  it("3.2 nhận 3 phần ngoài cặp chính; 1.2 nhận Mục tiêu; 2.5 nhận Yêu cầu khác (in từ Spine)", () => {
    const of = (text: string) => outline.find((e) => e.heading_text === text)!
    expect(of("3.2 Chức năng")).toMatchObject({ status: "receives", from_heading: ["2.2.2 Đặc tả use case", "3.1.4 Chức năng không có màn hình", "5.1 Quy tắc nghiệp vụ"] })
    expect(of("3.2 Chức năng").parts?.[0]).toEqual({ heading_text: "3 Yêu cầu chức năng", kind: "pair" })
    expect(of("1.2 Phạm vi sản phẩm")).toMatchObject({ status: "receives", from_heading: ["Mục tiêu"] })
    expect(of("2.5 Giả định và phụ thuộc")).toMatchObject({ status: "receives", from_spine: true, from_heading: ["5.4 Yêu cầu khác"] })
    expect(outline.filter((e) => e.status === "receives").length).toBeGreaterThanOrEqual(8)
  })

  it("lịch sử thay đổi ghép vào bảng lịch sử đầu tài liệu của mẫu (không Không in ra)", () => {
    expect(groups.conflict.find((c) => c.kind === "record_of_changes")).toMatchObject({ new_key: null, suggested: "map_by_header", suggested_reason: "keep_history" })
  })

  it("không mục có dữ liệu nào báo Không in ra; mục cần viết chỉ là mục không cặp, không phần gộp, Spine trống", () => {
    expect(outline.filter((e) => e.status === "dropped")).toEqual([])
    const needs = outline.filter((e) => e.status === "needs_content").map((e) => e.heading_text)
    expect(needs).toContain("1.4 Tài liệu tham khảo")
    expect(needs).not.toContain("1.1 Mục đích tài liệu")
    expect(needs).not.toContain("2.5 Giả định và phụ thuộc")
  })
})
