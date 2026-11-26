/**
 * FLF-469: CR thêm / xoá cả một chức năng (bộ nhận ý riêng), ô thêm chức năng của mục tính năng, văn xuôi nhắc phần tử đã
 * xoá, khuôn phần tử trong prompt C-4.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { useCaseIntent } from "../spine/use-case-propagation.js"
import { crBatchIntent } from "./add-use-case.service.js"
import { elementSchemaLine, elementSchemasText } from "./element-schemas.js"
import { featureSlots, findSpineLocations, mentionNames, removedMentionLocations } from "./spine-location.js"
import { crStructuralIntent } from "./structural-intent.js"

const cr = (title: string, targets: string[] = []) => ({ title, description: "", amendments: [], clarifications: [], targets: { entity_paths: targets } }) as never

describe("crStructuralIntent", () => {
  it("nhận Bỏ / Thêm chức năng, màn hình; sửa chức năng có sẵn thì không", () => {
    expect(crStructuralIntent(cr("Bỏ chức năng 3.3.5 Gửi tin nhắn Trò chuyện với Shop"))).toBe("remove")
    expect(crStructuralIntent(cr("Thêm một chức năng mới đổi địa chỉ giao hàng"))).toBe("add")
    expect(crStructuralIntent(cr("Xoá màn hình Báo cáo"))).toBe("remove")
    expect(crStructuralIntent(cr("Thêm validation cho chức năng Đăng nhập"))).toBeNull()
    expect(crStructuralIntent(cr("Bổ sung cho chức năng Thanh toán"))).toBeNull()
    expect(crStructuralIntent(cr("Không thêm chức năng nữa"))).toBeNull()
  })

  it("Cho phép … + đích là chức năng / mục tính năng ⇒ add (yếu); không có đích chức năng ⇒ null", () => {
    expect(crStructuralIntent(cr("Cho phép người mua đổi địa chỉ giao hàng của đơn", ["feature:F3"]))).toBe("add")
    expect(crStructuralIntent(cr("Cho phép người mua đổi địa chỉ giao hàng của đơn", ["actors[id=A01]"]))).toBeNull()
  })

  it("chat trước baseline không đổi: useCaseIntent vẫn null với câu không nhắc use case; crBatchIntent ưu tiên use case", () => {
    expect(useCaseIntent("Bỏ chức năng 3.3.5 Gửi tin nhắn")).toBeNull()
    expect(crBatchIntent(cr("Bỏ chức năng X"))).toEqual({ intent: "remove", structural: true })
    expect(crBatchIntent(cr("Thêm use case Gửi cảnh báo"))).toEqual({ intent: "add", structural: false })
    expect(crBatchIntent(cr("Đổi màu nút"))).toBeNull()
  })
})

const fnSpine = (): Spine => {
  const s = createEmptySpine({ name: "ChoViet" })
  s.features.push({ id: "F3", name: "Theo dõi đơn hàng", order: 3 } as never)
  s.functions.push(
    { id: "FR-1", name: "Xuất thời khóa biểu ra Excel", screen_id: null, feature_id: "F3", order: 0, trigger: "", description: "Xuất ra tệp", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null } as never,
    { id: "FR-2", name: "Xem đơn", screen_id: null, feature_id: "F3", order: 1, trigger: "", description: "Xem", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null } as never
  )
  s.custom_sections.push({ id: "CS01", heading: "Tổng quan", level: 2, blocks: [{ kind: "paragraph", text: "Người dùng có thể Xuất Excel hoặc in. Ngoài ra chọn đơn." }] } as never)
  return s
}

describe("featureSlots", () => {
  it("mục tính năng ⇒ ô functions[] và screens[] gắn đúng mục tính năng; mục chức năng ⇒ functions[] của tính năng chứa nó", () => {
    const s = fnSpine()
    expect(featureSlots(s, "feature:F3")).toEqual([{ path: "functions[]", section: "feature:F3" }, { path: "screens[]", section: "feature:F3" }])
    expect(featureSlots(s, "function:FR-2")).toEqual([{ path: "functions[]", section: "feature:F3" }])
    expect(featureSlots(s, "feature:ZZ")).toEqual([])
    const found = findSpineLocations(s, ["feature:F3"], [])
    expect(found.find((f) => f.path === "functions[]")).toMatchObject({ section_id: "feature:F3", found_by: ["spine_link"] })
  })
})

describe("removedMentionLocations", () => {
  it("tên ngắn", () => {
    expect(mentionNames("FR-1", "Xuất thời khóa biểu ra Excel")).toEqual(["FR-1", "Xuất thời khóa biểu ra Excel", "Xuất Excel"])
    expect(mentionNames("A1", "Admin")).toEqual(["A1", "Admin"])
  })

  it("xoá chức năng ⇒ đoạn nguyên văn nhắc 'Xuất Excel' thành vị trí mention; chỗ không nhắc thì không", () => {
    const s = fnSpine()
    const after = structuredClone(s)
    after.functions = after.functions.filter((f) => f.id !== "FR-1")
    const found = removedMentionLocations(s, after, new Set())
    expect(found.map((f) => f.path)).toEqual(["custom_sections[id=CS01]"])
    expect(found[0]).toMatchObject({ found_by: ["mention"], entity_paths: ["functions[id=FR-1]"] })
    // đã là vị trí của CR ⇒ bỏ qua; giới hạn số vị trí
    expect(removedMentionLocations(s, after, new Set(["custom_sections[id=CS01]"]))).toEqual([])
    expect(removedMentionLocations(s, after, new Set(), 0)).toEqual([])
  })
})

describe("element_schemas", () => {
  it("khuôn sinh từ schema: entities có attributes[].kind + required, relation_verbs có pattern", () => {
    const line = elementSchemaLine("entities")!
    expect(line).toContain("attributes: { name*: string, kind*:")
    expect(line).toContain("relation_verbs: record<string, string(pattern ^[a-z]+( [a-z]+)*$)>")
    expect(elementSchemaLine("actors")).toContain("flows_in: string[]")
    expect(elementSchemaLine("không_có")).toBeNull()
  })

  it("chỉ các mảng của vị trí, không lặp; không có ⇒ (none)", () => {
    const text = elementSchemasText([{ path: "entities[]" }, { path: "entities[id=E1]" }, { path: "functions[id=F1]" }])
    expect(text.match(/^entities\[\]:/gm)).toHaveLength(1)
    expect(text).toContain("functions[]:")
    expect(elementSchemasText([])).toBe("(none)")
  })
})
