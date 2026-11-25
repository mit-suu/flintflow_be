/**
 * FLF-483 (M4-a): giá trị cụ thể ("5 triệu", "30 phút") tìm chắc chắn, không qua xếp hạng từ khoá.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { crLiteralText, literalHits, literalValues } from "./literal-values.js"
import { KEYWORD_MAX_HITS, findSpineLocations, listElements } from "./spine-location.js"

describe("literalValues", () => {
  it("hạ COD từ 5 triệu xuống 3 triệu ⇒ hai giá trị tiền", () => {
    const v = literalValues("hạ COD từ 5 triệu xuống 3 triệu")
    expect(v.map((l) => [l.kind, l.amount])).toEqual([
      ["money", 5_000_000],
      ["money", 3_000_000]
    ])
  })

  it("mọi cách viết cùng khớp 5 triệu", () => {
    const folded = (t: string) => literalValues(t)[0]?.folded
    const target = folded("5 triệu")
    for (const t of ["5.000.000đ", "5,000,000 VND", "5tr", "5 000 000 đồng".replace(/ (?=\d{3})/g, "."), "5000k", "5 triệu đồng"]) expect(folded(t), t).toBe(target)
  })

  it("mã tài liệu, số mục, phiên bản, câu đếm ⇒ không ra giá trị", () => {
    for (const t of ["UC-16", "mục 3.4.1", "version 1.0", "gồm 15 use case", "FR-3.4.1 và REQ-INT-005", "PAY-010 tr"]) expect(literalValues(t), t).toEqual([])
  })

  it("30 phút khớp 30 phút, không khớp 300 phút", () => {
    const hits = literalHits(
      [
        { path: "a", value: { text: "Phiên hết hạn sau 30 phút không hoạt động" } },
        { path: "b", value: { text: "Lưu nháp tối đa 300 phút" } },
        { path: "c", value: { text: "Hết hạn sau 30 PHÚT" } }
      ],
      literalValues("đổi thời gian hết phiên từ 30 phút")
    )
    expect(hits).toEqual(["a", "c"])
  })

  it("tiền so theo số đồng: phần tử ghi 5.000.000đ khớp CR nói 5 triệu, 50 triệu không khớp", () => {
    const hits = literalHits(
      [
        { path: "a", value: "Đơn tối đa 5.000.000đ" },
        { path: "b", value: "Đơn tối đa 50 triệu" },
        { path: "c", value: "Giảm 5 triệu đồng" }
      ],
      literalValues("5 triệu")
    )
    expect(hits).toEqual(["a", "c"])
  })
})

describe("crLiteralText", () => {
  it("gom tiêu đề, mô tả, lệnh gộp thêm, câu trả lời, từ khoá có chữ số; bỏ câu hỏi và từ khoá không số", () => {
    const text = crLiteralText({
      title: "Sửa 5 triệu",
      description: "d",
      amendments: [{ text: "thêm 30 phút" }],
      clarifications: [{ round: 1, questions: ["mức 9 triệu?"], answers: ["3 triệu"], suggestions: [] }],
      targets: { entity_paths: [], keywords: ["COD", "7 ngày"] }
    } as never)
    expect(text).toContain("5 triệu")
    expect(text).toContain("30 phút")
    expect(text).toContain("3 triệu")
    expect(text).toContain("7 ngày")
    expect(text).not.toContain("9 triệu")
    expect(text).not.toContain("COD")
  })
})

/** Spine 60 phần tử: 20 nhắc COD, 3 nhắc "5 triệu" (dự án, chức năng có validation, mục riêng dạng bảng). */
const bigSpine = (): Spine => {
  const s = createEmptySpine({ name: "Shop" })
  s.project.release_scope = { in: ["Thanh toán COD", "COD giới hạn 5 triệu đồng mỗi đơn"], out: [] } as never
  for (let i = 1; i <= 20; i++) s.business_rules.push({ id: `BR-${String(i).padStart(2, "0")}`, statement: `Đơn COD cần xác nhận qua VNPay lần ${i}`, tier: "detail" } as never)
  s.functions.push({ id: "FR-3.4.1", name: "Thanh toán COD", description: "", business_rule_ids: [], screen_id: null, validations: [{ id: "V1", rule: "COD chỉ áp dụng khi tổng đơn tối đa 5 triệu đồng" }] } as never)
  s.custom_sections.push({
    id: "CS62",
    heading: "5.3 Bảng giá trị",
    level: 2,
    source: "import",
    blocks: [{ kind: "table", text: "", rows: [["COD tối đa", "5.000.000đ"]], image_ref: null }]
  } as never)
  for (let i = 1; i <= 25; i++) s.nfrs.push({ id: `NFR-${i}`, category: "performance", kind: "quantitative", statement: `COD VNPay MoMo thanh toán khi nhận hàng xử lý ${i}`, metric: "m", threshold: "t", priority: null } as never)
  return s
}

describe("findSpineLocations với giá trị cụ thể (ChoViet #4)", () => {
  const keywords = ["5 triệu", "COD", "VNPay", "MoMo", "thanh toán khi nhận hàng"]

  it("hơn 15 phần tử nhắc COD / VNPay vẫn có đủ 3 chỗ ghi 5 triệu, found_by có keyword", () => {
    const spine = bigSpine()
    expect(listElements(spine).length).toBeGreaterThan(40)
    const found = findSpineLocations(spine, ["business_rules[id=BR-01]"], keywords, [], { literals: literalValues("sửa mọi chỗ 5 triệu thành 3 triệu") })
    for (const path of ["project", "functions[id=FR-3.4.1]", "custom_sections[id=CS62]"]) {
      expect(found.find((f) => f.path === path), path).toMatchObject({ found_by: expect.arrayContaining(["keyword"]), keyword_score: 1 })
    }
    // giá trị cụ thể không tính vào trần từ khoá
    expect(found.filter((f) => f.found_by.includes("keyword") && f.keyword_score !== 1).length).toBeLessThanOrEqual(KEYWORD_MAX_HITS)
  })

  it("từ khoá là giá trị cụ thể không còn đi qua BM25 (khi đã có literals)", () => {
    const spine = bigSpine()
    const withLits = findSpineLocations(spine, [], ["5 triệu"], [], { literals: literalValues("5 triệu") }).map((f) => f.path)
    expect(withLits).toEqual(["project", "functions[id=FR-3.4.1]", "custom_sections[id=CS62]"])
  })

  it("không có literals ⇒ hành vi cũ", () => {
    const spine = bigSpine()
    expect(findSpineLocations(spine, [], ["COD"]).length).toBeLessThanOrEqual(KEYWORD_MAX_HITS)
  })
})
