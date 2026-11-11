/** FLF-375 — business-flow §3.2 "Hai người sửa cùng lúc": kiểm lại lúc xác nhận trên nội dung hiện tại (hàm thuần). */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { LocationProposal } from "./change-location.model.js"
import { classifyAtConfirm } from "./concurrent-edit.js"
import { locationDisplay } from "./location-display.js"
import { elementValue, sha256, valueText } from "./spine-location.js"

const PATH = "use_cases[id=UC-01]"
const base = (): Spine => {
  const s = createEmptySpine({ name: "Shop" })
  s.use_cases.push({ id: "UC-01", name: "Place order", actor_ids: [], function_ids: [], description: "Khách đặt hàng trực tuyến và thanh toán.", includes: [], extends: [] } as never)
  return s
}
const set = (s: Spine, patch: Record<string, unknown>): Spine => ({ ...s, use_cases: s.use_cases.map((u) => (u.id === "UC-01" ? { ...u, ...patch } : u)) }) as Spine

/** Đề xuất lúc AI soạn (9:00): đổi mô tả "Khách" ⇒ "Người mua". */
const proposalOn = (s: Spine): LocationProposal => {
  const before = elementValue(s, PATH) as Record<string, unknown>
  const after = { ...before, description: "Người mua đặt hàng trực tuyến và thanh toán." }
  return { old_text: valueText(before), new_text: valueText(after), comment_text: null, spine_ops: [{ op: "set", path: PATH, value: after }], assumptions: [] }
}

describe("classifyAtConfirm", () => {
  it("không ai sửa ⇒ ghi như thường", () => {
    const s = base()
    expect(classifyAtConfirm(s, PATH, proposalOn(s)).kind).toBe("unchanged")
  })

  it("người khác đã sửa đúng như đề xuất ⇒ same (không ghi lại)", () => {
    const s = base()
    const p = proposalOn(s)
    expect(classifyAtConfirm(set(s, { description: "Người mua đặt hàng trực tuyến và thanh toán." }), PATH, p).kind).toBe("same")
  })

  it("người khác sửa đúng chữ đề xuất định đổi ⇒ conflict (màn so sánh 3 cột, không ghi đè)", () => {
    const s = base()
    const p = proposalOn(s)
    expect(classifyAtConfirm(set(s, { description: "Khách hàng đặt hàng trực tuyến và thanh toán." }), PATH, p).kind).toBe("conflict")
  })

  it("người khác sửa phần khác trong cùng chỗ ⇒ ghép: giữ phần họ sửa + phần đề xuất đổi", () => {
    const s = base()
    const p = proposalOn(s)
    const now = set(s, { name: "Place an order" })
    const out = classifyAtConfirm(now, PATH, p)
    expect(out.kind).toBe("rebased")
    if (out.kind !== "rebased") return
    const merged = (out.proposal.spine_ops[0] as { value: Record<string, unknown> }).value
    expect(merged).toMatchObject({ name: "Place an order", description: "Người mua đặt hàng trực tuyến và thanh toán." })
    expect(out.proposal.old_text).toBe(valueText(elementValue(now, PATH)))
  })

  it("đề xuất xoá phần tử mà người khác đã xoá ⇒ same; người khác sửa nó ⇒ conflict", () => {
    const s = base()
    const p: LocationProposal = { old_text: valueText(elementValue(s, PATH)), new_text: null, comment_text: null, spine_ops: [{ op: "remove", path: PATH }], assumptions: [] }
    expect(classifyAtConfirm({ ...s, use_cases: [] } as Spine, PATH, p).kind).toBe("same")
    expect(classifyAtConfirm(set(s, { name: "Checkout" }), PATH, p).kind).toBe("conflict")
  })

  it("vị trí thêm mới: người khác thêm phần tử khác ⇒ ghép (cập nhật base_hash); đã có đúng phần tử đó ⇒ same", () => {
    const s = base()
    const uc2 = { id: "UC-02", name: "Track order", actor_ids: [], function_ids: [], description: "", includes: [], extends: [] }
    const p: LocationProposal = { old_text: "[]", base_hash: sha256(valueText(s.use_cases)), new_text: valueText([uc2]), comment_text: null, spine_ops: [{ op: "add", path: "use_cases[]", value: uc2 }], assumptions: [] }
    const other = { ...uc2, id: "UC-03", name: "Cancel order" }
    const withOther = { ...s, use_cases: [...s.use_cases, other] } as Spine
    const out = classifyAtConfirm(withOther, "use_cases[]", p)
    expect(out.kind).toBe("rebased")
    if (out.kind === "rebased") expect(out.proposal.base_hash).toBe(sha256(valueText(withOther.use_cases)))
    expect(classifyAtConfirm({ ...s, use_cases: [...s.use_cases, uc2] } as Spine, "use_cases[]", p).kind).toBe("same")
  })
})

describe("locationDisplay - không lộ mã nội bộ", () => {
  it("đoạn văn mục riêng ⇒ kind paragraph, nhãn là trích đoạn; trước / sau là câu, không JSON", () => {
    const s = base()
    s.custom_sections.push({ id: "CS11", heading: "", level: 4, source: "import", blocks: [{ kind: "paragraph", text: "UC-05, UC-06, UC-09 có thêm sơ đồ hoạt động.", rows: null, image_ref: null }] } as never)
    const path = "custom_sections[id=CS11]"
    const after = { ...(elementValue(s, path) as object), blocks: [{ kind: "paragraph", text: "UC-05, UC-06 có thêm sơ đồ hoạt động.", rows: null, image_ref: null }] }
    const d = locationDisplay(s, path, "edit", { old_text: valueText(elementValue(s, path)), new_text: valueText(after), comment_text: null, spine_ops: [] })
    expect(d).toMatchObject({ kind: "paragraph", change: "edit", before: "UC-05, UC-06, UC-09 có thêm sơ đồ hoạt động.", after: "UC-05, UC-06 có thêm sơ đồ hoạt động." })
    expect(JSON.stringify(d)).not.toMatch(/CS11|image_ref|\[id=|list_item/)
  })

  it("xoá use case ⇒ change remove, nhãn là tên; mã nội bộ kiểu F-3.2.9 không hiện, mã khách UC-01 giữ", () => {
    const s = base()
    s.use_cases.push({ id: "F-3.2.9", name: "Nhập/xuất dữ liệu Excel", actor_ids: [], function_ids: [], description: "", includes: [], extends: [] } as never)
    const d = locationDisplay(s, "use_cases[id=F-3.2.9]", "edit", { old_text: valueText(elementValue(s, "use_cases[id=F-3.2.9]")), new_text: null, comment_text: null, spine_ops: [{ op: "remove", path: "use_cases[id=F-3.2.9]" }] })
    expect(d).toMatchObject({ kind: "use_cases", change: "remove", label: "Nhập/xuất dữ liệu Excel" })
    expect(locationDisplay(s, PATH, null, null).label).toBe("UC-01 Place order")
  })
})
