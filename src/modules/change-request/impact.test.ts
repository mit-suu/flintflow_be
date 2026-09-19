/**
 * C-3 tìm vị trí ảnh hưởng — phần hàm thuần (`findLocations`, `elementPathOf`, `formatLocationId`). FLF-172, plan §8.3.
 * Phần chạy trên DB (FieldAnchor, khoá, tìm lại) ở `test/integration/mode1/impact.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { MAX_LOCATIONS, elementPathOf, findLocations, formatLocationId } from "./cr-impact.service.js"

const block = (block_id: string, text: string, section_id: string | null = null, mentions: { entity: string; id: string }[] = []) => ({
  block_id,
  text,
  section_id,
  mentions,
  anchor: { ordinal: Number(block_id.slice(1)) }
})

const owner = (s: string) => `owner:${s}`

describe("C-3 findLocations — hợp ba nguồn", () => {
  const blocks = [
    block("B0001", "2.2.2 Use Case Descriptions", "fixed:2.2.2"),
    block("B0002", "UC-01", "fixed:2.2.2", [{ entity: "use_case", id: "UC-01" }]),
    block("B0003", "Register account", "fixed:2.2.2"),
    block("B0004", "3.2 Authentication", "feature:F-3.2", [{ entity: "feature", id: "F-3.2" }]),
    block("B0005", "Learner creates an account with email (UC-01).", "function:FR-3.2.1", [{ entity: "use_case", id: "UC-01" }]),
    block("B0006", "Internal notes about registration.", null)
  ]

  it("mỗi nguồn ghi đúng found_by; block trùng giữa các nguồn chỉ ra một vị trí, gộp found_by + entity_paths", () => {
    const found = findLocations(
      blocks,
      ["use_cases[id=UC-01]", "functions[id=FR-3.2.1]"],
      new Map([["use_cases[id=UC-01]", ["B0002"]]]),
      ["register account", "email"],
      owner
    )
    expect(found).toEqual([
      // anchor (spine_link) + mention + keyword trên cùng block
      { block_id: "B0002", found_by: ["spine_link", "mention"], entity_paths: ["use_cases[id=UC-01]"], owner_step: "owner:fixed:2.2.2" },
      { block_id: "B0003", found_by: ["keyword"], entity_paths: [], owner_step: "owner:fixed:2.2.2" },
      // section của function đích (spine_link) + mention UC-01 + keyword "email"
      {
        block_id: "B0005",
        found_by: ["mention", "spine_link", "keyword"],
        entity_paths: ["use_cases[id=UC-01]", "functions[id=FR-3.2.1]"],
        owner_step: "owner:function:FR-3.2.1"
      }
    ])
    // khử trùng: không block nào xuất hiện hai lần
    expect(new Set(found.map((f) => f.block_id)).size).toBe(found.length)
  })

  it("feature đích ⇒ block thuộc section `feature:<id>` (spine_link) + mention feature", () => {
    const found = findLocations(blocks, ["features[id=F-3.2]"], new Map(), [], owner)
    expect(found).toEqual([{ block_id: "B0004", found_by: ["spine_link", "mention"], entity_paths: ["features[id=F-3.2]"], owner_step: "owner:feature:F-3.2" }])
  })

  it("block không có section ⇒ owner_step null; anchor trỏ block không thuộc version hiện tại bị bỏ", () => {
    const found = findLocations(blocks, ["use_cases[id=UC-09]"], new Map([["use_cases[id=UC-09]", ["B9999"]]]), ["registration"], owner)
    expect(found).toEqual([{ block_id: "B0006", found_by: ["keyword"], entity_paths: [], owner_step: null }])
  })

  it("mảng không có mention (vd `glossary`) và path không phải phần tử không làm hỏng", () => {
    expect(findLocations(blocks, ["glossary[id=G-1]", "project.vision"], new Map(), [], owner)).toEqual([])
  })

  it("thứ tự kết quả theo thứ tự block, không theo nguồn", () => {
    const found = findLocations(blocks, ["use_cases[id=UC-01]"], new Map(), ["Internal notes", "2.2.2"], owner)
    expect(found.map((f) => f.block_id)).toEqual(["B0001", "B0002", "B0005", "B0006"])
  })
})

describe("C-3 findLocations — từ khoá", () => {
  it("theo ranh giới từ, không phân biệt hoa thường, không bắt nhầm trong từ khác", () => {
    const blocks = [block("B0001", "The learner signs in"), block("B0002", "Sign in page"), block("B0003", "Design notes"), block("B0004", "SIGN-IN button")]
    expect(findLocations(blocks, [], new Map(), ["sign"], owner).map((f) => f.block_id)).toEqual(["B0002", "B0004"])
  })

  it("từ khoá < 3 ký tự (sau trim) bị bỏ; ký tự đặc biệt regex được thoát", () => {
    const blocks = [block("B0001", "Go to the menu"), block("B0002", "Price is 5.0 (VAT) + tax"), block("B0003", "Price is 5x0")]
    expect(findLocations(blocks, [], new Map(), ["  to ", "go"], owner)).toEqual([])
    expect(findLocations(blocks, [], new Map(), ["5.0 (VAT) +"], owner).map((f) => f.block_id)).toEqual(["B0002"])
    expect(findLocations(blocks, [], new Map(), ["5.0"], owner).map((f) => f.block_id)).toEqual(["B0002"])
  })

  it("không đích, không từ khoá ⇒ không vị trí", () => {
    expect(findLocations([block("B0001", "anything")], [], new Map(), [], owner)).toEqual([])
  })
})

describe("C-3 trần số vị trí + định dạng", () => {
  it(`một CR tối đa ${MAX_LOCATIONS} vị trí (lấy theo thứ tự tài liệu)`, () => {
    const many = Array.from({ length: MAX_LOCATIONS + 15 }, (_, i) => block(`B${String(i + 1).padStart(4, "0")}`, `login step ${i}`))
    const found = findLocations(many, [], new Map(), ["login"], owner)
    expect(found).toHaveLength(MAX_LOCATIONS)
    expect(found[found.length - 1].block_id).toBe(`B${String(MAX_LOCATIONS).padStart(4, "0")}`)
  })

  it("elementPathOf + formatLocationId", () => {
    expect(elementPathOf("nfrs[id=NFR-01].threshold")).toBe("nfrs[id=NFR-01]")
    expect(elementPathOf("functions[id=FR-3.2.1]")).toBe("functions[id=FR-3.2.1]")
    expect(elementPathOf("actors")).toBeNull()
    expect(formatLocationId(1)).toBe("L001")
    expect(formatLocationId(80)).toBe("L080")
    expect(formatLocationId(1234)).toBe("L1234")
  })
})
