/**
 * FLF-483 (M1-a): "xoá nội dung" nhận cả xoá mục con bằng op `set`, và cổng tự ghi `autoSubmitHold`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import { hasRemoveOp, removedItems } from "./content-removal.js"
import { autoSubmitHold } from "./verify.service.js"

const base = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.functions.push({
    id: "F1",
    name: "Đặt hàng",
    description: "",
    validations: [
      { id: "V1", rule: "Giỏ hàng không rỗng" },
      { id: "V2", rule: "Tổng đơn tối đa 5 triệu" }
    ],
    normal: ["Chọn sản phẩm", "Thanh toán"]
  } as never)
  s.business_rules.push({ id: "BR-01", statement: "Quy tắc A", tier: "detail" } as never)
  return s
}

const withFn = (patch: Record<string, unknown>): Spine => {
  const s = structuredClone(base())
  Object.assign(s.functions[0] as unknown as Record<string, unknown>, patch)
  return s
}

describe("removedItems", () => {
  it("set bỏ một điều kiện có id ⇒ một mục bị xoá, nhãn là câu điều kiện", () => {
    const after = withFn({ validations: [{ id: "V1", rule: "Giỏ hàng không rỗng" }] })
    expect(removedItems(base(), after, ["functions[id=F1]"])).toEqual([{ path: "functions[id=F1]", label: "V2 Tổng đơn tối đa 5 triệu" }])
  })

  it("mảng chuỗi ngắn đi ⇒ không tính xoá; sửa chữ của mục con ⇒ không tính", () => {
    expect(removedItems(base(), withFn({ normal: ["Chọn sản phẩm"] }), ["functions[id=F1]"])).toEqual([])
    expect(removedItems(base(), withFn({ validations: [{ id: "V1", rule: "đổi chữ" }, { id: "V2", rule: "x" }] }), ["functions[id=F1]"])).toEqual([])
  })

  it("phần tử biến mất (op remove cả phần tử) ⇒ có xoá; thêm mục con ⇒ không", () => {
    const after = structuredClone(base())
    after.business_rules = []
    expect(removedItems(base(), after, ["business_rules[id=BR-01]"])).toEqual([{ path: "business_rules[id=BR-01]", label: "BR-01 Quy tắc A" }])
    expect(removedItems(base(), withFn({ validations: [{ id: "V1", rule: "a" }, { id: "V2", rule: "b" }, { id: "V3", rule: "c" }] }), ["functions[id=F1]"])).toEqual([])
  })
})

const loc = (over: Partial<IChangeLocation> & { ops: unknown[] }): IChangeLocation => {
  const { ops, ...rest } = over
  return { location_id: "L001", path: "functions[id=F1]", conclusion: "edit", proposal: { old_text: "", new_text: "", comment_text: null, spine_ops: ops }, verify: null, ...rest } as unknown as IChangeLocation
}

describe("autoSubmitHold", () => {
  const dropV2 = [{ op: "set", path: "functions[id=F1].validations", value: [{ id: "V1", rule: "Giỏ hàng không rỗng" }] }]
  const after = withFn({ validations: [{ id: "V1", rule: "Giỏ hàng không rỗng" }] })

  it("hasRemoveOp: chỉ op remove", () => {
    expect(hasRemoveOp({ spine_ops: [{ op: "remove", path: "x" }] })).toBe(true)
    expect(hasRemoveOp({ spine_ops: dropV2 })).toBe(false)
    expect(hasRemoveOp(null)).toBe(false)
  })

  it("set bỏ điều kiện ⇒ content_removed", () => {
    expect(autoSubmitHold(base(), [loc({ ops: dropV2 })], after)).toBe("content_removed")
  })

  it("op remove ⇒ content_removed, kể cả khi lô không chạy khô được (after null)", () => {
    expect(autoSubmitHold(base(), [loc({ ops: [{ op: "remove", path: "business_rules[id=BR-01]" }] })], null)).toBe("content_removed")
  })

  it("không xoá, không cờ ⇒ null; có cờ AI ⇒ ai_flags; xoá thắng cờ AI", () => {
    const edit = [{ op: "set", path: "functions[id=F1].name", value: "Mua hàng" }]
    const afterEdit = withFn({ name: "Mua hàng" })
    expect(autoSubmitHold(base(), [loc({ ops: edit })], afterEdit)).toBeNull()
    const flagged = loc({ ops: edit, verify: { code_ok: true, violations: [], ai_flags: [{ rule: "x", message: "y" }], at: new Date() } })
    expect(autoSubmitHold(base(), [flagged], afterEdit)).toBe("ai_flags")
    expect(autoSubmitHold(base(), [{ ...flagged, proposal: { ...flagged.proposal!, spine_ops: dropV2 } } as IChangeLocation], after)).toBe("content_removed")
  })

  it("bỏ qua vị trí không phải edit", () => {
    expect(autoSubmitHold(base(), [loc({ conclusion: "comment", ops: dropV2 })], after)).toBeNull()
  })
})
