/**
 * Luật C-4 / C-5 / C-6 của change request ở phần hàm thuần: cảnh báo + "Vẫn làm", lỗi luật giữ theo ý mình, mục ngoài phạm vi,
 * xoá nội dung, ước chi phí C-4, trạng thái "CR mở". Luồng trên DB ở `test/integration/mode1/cr-flow-rules.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { CR_OPEN_STATUSES, CR_STATUSES, isTerminal } from "./change-request.state.js"
import { hasRemoveOp, isRemoveOp } from "./location-display.js"
import { outOfScopeKind } from "./out-of-scope.js"
import { LARGE_CR_LOCATIONS, applyProposal, locationPromptText, plainProposal, proposeEstimate } from "./propose.service.js"
import { elementValue, valueText } from "./spine-location.js"
import { checkLocation, checkSpineOps, hasPendingWarning, isKeepable, withoutKept } from "./verify.service.js"
import { createChangeRequestSchema, patchLocationRequestSchema, revertRequestSchema } from "./change-request.dto.js"

const cr = { cr_id: "CR-001" } as IChangeRequest

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "", flows_in: [], flows_out: [] } as never, { id: "A02", name: "Admin", kind: "human", description: "", flows_in: [], flows_out: [] } as never)
  s.custom_sections.push(
    { id: "CS01", heading: "Appendix A", level: 2, source: "import", blocks: [{ kind: "paragraph", text: "Old text", rows: null, image_ref: null }] } as never,
    { id: "CS02", heading: "Empty", level: 2, source: "import", blocks: [] } as never
  )
  return s
}

const loc = (over: Partial<IChangeLocation> = {}): IChangeLocation =>
  ({ location_id: "L001", path: "actors[id=A02]", section_id: "fixed:2.1", found_by: ["spine_link"], entity_paths: [], conclusion: null, proposal: null, warning: null, kept_intent: false, kept_violations: [], verify: null, ...over }) as unknown as IChangeLocation

describe("mục ngoài phạm vi (outOfScopeKind)", () => {
  const scope = new Set(["custom:CS01", "custom:CS02"])

  it("mục riêng ngoài phạm vi: có nội dung ⇒ sửa chữ, trống ⇒ chỉ ghi chú", () => {
    expect(outOfScopeKind(spine(), { path: "custom_sections[id=CS01]", section_id: "custom:CS01" }, scope)).toBe("text")
    expect(outOfScopeKind(spine(), { path: "custom_sections[id=CS02]", section_id: "custom:CS02" }, scope)).toBe("comment")
  })

  it("mục trong phạm vi hoặc phần tử không phải mục riêng ⇒ null", () => {
    expect(outOfScopeKind(spine(), { path: "custom_sections[id=CS01]", section_id: "custom:CS01" }, new Set())).toBeNull()
    expect(outOfScopeKind(spine(), { path: "actors[id=A01]", section_id: "custom:CS01" }, scope)).toBeNull()
  })

  it("checkLocation: mục ngoài phạm vi còn trống mà kết luận edit ⇒ out_of_scope_empty; có nội dung thì không kiểm thêm", () => {
    const path = "custom_sections[id=CS02]"
    const s = spine()
    const ops = [{ op: "set", path: `${path}.blocks`, value: [{ kind: "paragraph", text: "New", rows: null, image_ref: null }] }]
    const l = loc({ path, section_id: "custom:CS02", conclusion: "edit", proposal: { old_text: valueText(elementValue(s, path)), new_text: "x", comment_text: null, spine_ops: ops } as never })
    const locks = new Map([[path, "CR-001"]])
    expect(checkLocation(cr, l, s, locks, undefined, "comment").map((v) => v.rule)).toContain("out_of_scope_empty")
    expect(checkLocation(cr, l, s, locks, undefined, "text").map((v) => v.rule)).not.toContain("out_of_scope_empty")
    expect(checkLocation(cr, l, s, locks).map((v) => v.rule)).not.toContain("out_of_scope_empty")
  })
})

describe("C-5 lỗi đỏ mới", () => {
  // Hai actor trùng tên ⇒ luật đỏ duplicate_name (không bị hồ sơ chế độ 1 loại)
  const dup = [{ op: "set", path: "actors[id=A02].name", value: "Learner" }]
  const edit = loc({ proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: dup } as never, conclusion: "edit" })

  it("op làm phát sinh cờ đỏ ⇒ new_red_flag; vị trí được miễn (sửa chữ mục ngoài phạm vi) thì không bị gắn", () => {
    const res = checkSpineOps(spine(), cr, [edit])
    expect(res.get("L001")?.length).toBeGreaterThan(0)
    expect(res.get("L001")?.every((v) => v.rule === "new_red_flag")).toBe(true)
    expect(checkSpineOps(spine(), cr, [edit], new Set(["L001"])).size).toBe(0)
  })

  it("giữ theo ý mình: chỉ new_red_flag là lỗi luật giữ được; lỗi chữ cũ không còn khớp thì không", () => {
    expect(isKeepable([{ rule: "new_red_flag" }])).toBe(true)
    expect(isKeepable([{ rule: "new_red_flag" }, { rule: "value_changed" }])).toBe(false)
    expect(isKeepable([{ rule: "value_changed" }])).toBe(false)
    expect(isKeepable([])).toBe(false)
  })

  it("withoutKept bỏ đúng mã luật đã giữ", () => {
    const vs = [
      { rule: "new_red_flag", message: "a" },
      { rule: "value_changed", message: "b" }
    ]
    expect(withoutKept(vs, ["new_red_flag"]).map((v) => v.rule)).toEqual(["value_changed"])
    expect(withoutKept(vs, [])).toHaveLength(2)
  })
})

describe("cảnh báo C-4 (applyProposal)", () => {
  const out = (over: Record<string, unknown>) => ({ location_id: "L001", conclusion: "edit", reason: "CR", spine_ops: [{ op: "set", path: "actors[id=A02].name", value: "Owner" }], assumptions: [], ...over }) as never

  it("model cảnh báo, BA chưa vẫn làm ⇒ kết luận comment, không op, lưu cảnh báo; chặn xác nhận", () => {
    const l = loc()
    applyProposal(l, spine(), out({ warning: { text: "Phá BR-02.", reason: "BR-02 cần đăng nhập." } }))
    expect(l.conclusion).toBe("comment")
    expect(l.proposal?.spine_ops).toEqual([])
    expect(l.proposal?.comment_text).toBe("Phá BR-02. BR-02 cần đăng nhập.")
    expect(l.warning).toEqual({ text: "Phá BR-02.", reason: "BR-02 cần đăng nhập." })
    expect(hasPendingWarning(l)).toBe(true)
  })

  it("đã kept_intent ⇒ bỏ cảnh báo model trả, soạn edit bình thường, hết chặn", () => {
    const l = loc({ kept_intent: true, warning: { text: "Phá BR-02.", reason: "r" } })
    applyProposal(l, spine(), out({ warning: { text: "Lại cảnh báo", reason: "r2" } }))
    expect(l.conclusion).toBe("edit")
    expect(l.proposal?.spine_ops).toHaveLength(1)
    expect(l.warning?.text).toBe("Phá BR-02.")
    expect(hasPendingWarning(l)).toBe(false)
  })

  it("đề xuất mới xoá 'giữ theo ý mình' cũ; cảnh báo chỉ chặn khi chưa bỏ chỗ đó", () => {
    const l = loc({ kept_violations: ["new_red_flag"] })
    applyProposal(l, spine(), out({}))
    expect(l.kept_violations).toEqual([])
    expect(hasPendingWarning(loc({ warning: { text: "t", reason: "r" }, conclusion: "not_related" }))).toBe(false)
  })

  it("chữ hiện cho người dùng không có dấu gạch dài; giá trị trong op giữ nguyên", () => {
    const em = String.fromCharCode(0x2014)
    const l = loc()
    applyProposal(l, spine(), out({ reason: `Đổi ${em} theo CR`, assumptions: [`Giả định ${em} 2 giây`], spine_ops: [{ op: "set", path: "actors[id=A02].name", value: `A ${em} B` }] }))
    expect(l.reason).toBe("Đổi - theo CR")
    expect(l.proposal?.assumptions).toEqual(["Giả định - 2 giây"])
    expect(JSON.stringify(l.proposal?.spine_ops)).toContain(em)
    expect(plainProposal(out({ warning: { text: `a${em}b`, reason: "r" } })).warning?.text).toBe("a - b")
  })

  it("prompt báo model đã 'vẫn làm' và mục ngoài phạm vi", () => {
    const text = locationPromptText(spine(), { ...loc({ kept_intent: true }), found_by: ["spine_link"], entity_paths: [] } as never, [], "text")
    expect(text).toContain("chose to proceed")
    expect(text).toContain("OUT OF SCOPE")
    expect(locationPromptText(spine(), loc() as never)).not.toContain("chose to proceed")
  })
})

describe("xoá nội dung và ước chi phí", () => {
  it("hasRemoveOp: mọi op remove, kể cả phần tử con; chỉ set / add thì không", () => {
    expect(isRemoveOp({ op: "remove", path: "actors[id=A01]" })).toBe(true)
    expect(hasRemoveOp({ spine_ops: [{ op: "set", path: "a.b", value: 1 }, { op: "remove", path: "use_cases[id=UC-1].steps[1]" }] })).toBe(true)
    expect(hasRemoveOp({ spine_ops: [{ op: "set", path: "a.b", value: 1 }, { op: "add", path: "actors[]", value: {} }] })).toBe(false)
    expect(hasRemoveOp(null)).toBe(false)
  })

  it("proposeEstimate: số lô theo chủ sở hữu, mỗi lô ≤ 4 vị trí, nhân giá một lô", () => {
    const s = spine()
    const many = Array.from({ length: 9 }, (_, i) => loc({ location_id: `L${i + 1}`, path: `actors[id=A${i + 1}]`, owner_step: "S-2.1", section_id: "fixed:2.1" }))
    const est = proposeEstimate(s, many, 3)
    expect(est).toEqual({ locations: 9, batches: 3, credits: 9 })
    // vị trí đã có kết luận và kiểm đạt thì không tính
    const done = many.map((l) => ({ ...l, conclusion: "edit", verify: { code_ok: true } }) as unknown as IChangeLocation)
    expect(proposeEstimate(s, done, 3).batches).toBe(0)
    expect(LARGE_CR_LOCATIONS).toBe(80)
  })
})

describe("CR mở và DTO", () => {
  it("CR_OPEN_STATUSES = mọi trạng thái chưa kết thúc", () => {
    expect([...CR_OPEN_STATUSES].sort()).toEqual(CR_STATUSES.filter((s) => !isTerminal(s)).sort())
    expect(CR_OPEN_STATUSES).toContain("draft")
    expect(CR_OPEN_STATUSES).not.toContain("written")
    expect(CR_OPEN_STATUSES).not.toContain("cancelled")
  })

  it("PATCH vị trí nhận action keep / proceed đi một mình; client không tự tạo nguồn revert", () => {
    expect(patchLocationRequestSchema.safeParse({ action: "keep" }).success).toBe(true)
    expect(patchLocationRequestSchema.safeParse({ action: "proceed" }).success).toBe(true)
    expect(patchLocationRequestSchema.safeParse({ action: "other" }).success).toBe(false)
    expect(patchLocationRequestSchema.safeParse({ action: "keep", conclusion: "edit" }).success).toBe(false)
    const base = { title: "t", description: "d", requester: "PM" }
    expect(createChangeRequestSchema.safeParse({ ...base, source: { kind: "revert", ref: "CR-001" } }).success).toBe(false)
    expect(revertRequestSchema.safeParse({ requester: "PM" }).success).toBe(true)
    expect(revertRequestSchema.safeParse({}).success).toBe(false)
  })
})
