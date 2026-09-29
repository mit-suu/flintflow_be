/**
 * C-5 kiểm đề xuất theo phần tử Spine — phần hàm thuần (`checkLocation`, `checkSpineOps`). Mode 1 v2 (FLF-186).
 * Luồng verify trên DB (AI chỉ vàng, redo ≤ 2 ⇒ manual_fix, pause) ở `test/integration/mode1/verify.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { MAX_REDO_PER_LOCATION, nextAfterVerifyFail } from "./change-request.state.js"
import { previewAfter } from "./propose.service.js"
import { elementValue, valueText } from "./spine-location.js"
import { checkLocation, checkSpineOps } from "./verify.service.js"

const cr = { cr_id: "CR-001" } as IChangeRequest
const PATH = "actors[id=A01]"
const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "" } as never, { id: "A02", name: "Admin", kind: "human", description: "" } as never)
  return s
}
const OLD = valueText(elementValue(spine(), PATH))
const RENAME = [{ op: "set", path: `${PATH}.name`, value: "Student" }]
const proposal = (over: Partial<NonNullable<IChangeLocation["proposal"]>> = {}) => ({
  old_text: OLD,
  new_text: previewAfter(spine(), PATH, RENAME),
  comment_text: null,
  spine_ops: RENAME as unknown[],
  ...over
})
const loc = (over: Partial<IChangeLocation> = {}): IChangeLocation => ({ location_id: "L001", path: PATH, conclusion: "edit", proposal: proposal(), ...over }) as IChangeLocation
const mine = new Map([[PATH, "CR-001"]])

describe("C-5 checkLocation — code (đỏ)", () => {
  it("đạt; chưa kết luận; not_related bỏ qua; phần tử đã xoá ⇒ element_missing", () => {
    expect(checkLocation(cr, loc(), spine(), mine)).toEqual([])
    expect(checkLocation(cr, loc({ conclusion: null }), spine(), mine).map((v) => v.rule)).toEqual(["unconcluded"])
    expect(checkLocation(cr, loc({ conclusion: "not_related", proposal: null }), spine(), new Map())).toEqual([])
    expect(checkLocation(cr, loc({ path: "actors[id=A99]" }), spine(), mine).map((v) => v.rule)).toEqual(["element_missing"])
  })

  it("mất khoá ⇒ path_not_locked; thiếu đề xuất ⇒ no_proposal", () => {
    expect(checkLocation(cr, loc(), spine(), new Map([[PATH, "CR-002"]])).map((v) => v.rule)).toEqual(["path_not_locked"])
    expect(checkLocation(cr, loc({ proposal: null }), spine(), mine).map((v) => v.rule)).toEqual(["no_proposal"])
  })

  it("edit không op ⇒ edit_without_ops; op không đổi gì ⇒ edit_no_change; op chạm phần tử không khoá ⇒ op_path_not_locked; thêm phần tử mới từ vị trí phần tử ⇒ add_outside_slot (chỉ thêm từ ô thêm mới — 2026-09-24)", () => {
    expect(checkLocation(cr, loc({ proposal: proposal({ spine_ops: [], new_text: OLD }) }), spine(), mine).map((v) => v.rule)).toEqual(["edit_without_ops"])
    const same = [{ op: "set", path: `${PATH}.name`, value: "Learner" }]
    expect(checkLocation(cr, loc({ proposal: proposal({ spine_ops: same, new_text: previewAfter(spine(), PATH, same) }) }), spine(), mine).map((v) => v.rule)).toEqual([
      "edit_no_change"
    ])
    const other = [...RENAME, { op: "set", path: "actors[id=A02].name", value: "Owner" }]
    expect(checkLocation(cr, loc({ proposal: proposal({ spine_ops: other }) }), spine(), mine).map((v) => v.rule)).toEqual(["op_path_not_locked"])
    const add = [...RENAME, { op: "add", path: "business_rules[]", value: { id: "BR-09", statement: "x", tier: "detail" } }]
    expect(checkLocation(cr, loc({ proposal: proposal({ spine_ops: add }) }), spine(), mine).map((v) => v.rule)).toEqual(["add_outside_slot"])
  })

  it("comment rỗng ⇒ comment_empty; comment có nội dung ⇒ đạt", () => {
    const comment = (text: string) => loc({ conclusion: "comment", proposal: proposal({ spine_ops: [], new_text: null, comment_text: text }) })
    expect(checkLocation(cr, comment(" "), spine(), mine).map((v) => v.rule)).toEqual(["comment_empty"])
    expect(checkLocation(cr, comment("Xem lại"), spine(), mine)).toEqual([])
  })

  it("giá trị tại path đã đổi kể từ lúc đề xuất ⇒ ném CR_VALUE_CHANGED kèm vị trí", () => {
    const changed = spine()
    ;(changed.actors[0] as { description: string }).description = "Edited elsewhere"
    expect(() => checkLocation(cr, loc(), changed, mine)).toThrow(expect.objectContaining({ code: "CR_VALUE_CHANGED", meta: { location_id: "L001", path: PATH } }))
  })
})

describe("C-5 checkSpineOps — op Spine chạy khô", () => {
  it("op hợp lệ ⇒ không vi phạm; chỉ op của vị trí edit được chạy khô", () => {
    expect(checkSpineOps(spine(), cr, [loc()]).size).toBe(0)
    expect(checkSpineOps(spine(), cr, [loc({ conclusion: "comment", proposal: proposal({ spine_ops: [{ op: "set", path: "actors[id=A99].name", value: "X" }] }) })]).size).toBe(0)
  })

  it("op phá bất biến ⇒ vi phạm gắn đúng vị trí sinh op; op sai định dạng ⇒ op_invalid", () => {
    const res = checkSpineOps(spine(), cr, [
      loc({ location_id: "L001" }),
      loc({ location_id: "L002", path: "actors[id=A02]", proposal: proposal({ spine_ops: [{ op: "set", path: "actors[id=A99].name", value: "X" }] }) }),
      loc({ location_id: "L003", proposal: proposal({ spine_ops: [{ nope: 1 }] }) })
    ])
    expect([...res.keys()].sort()).toEqual(["L002", "L003"])
    expect(res.get("L003")?.map((v) => v.rule)).toEqual(["op_invalid"])
  })

  it("previewAfter: giá trị sau op; op sai ⇒ null", () => {
    expect(previewAfter(spine(), PATH, RENAME)).toContain('"name": "Student"')
    expect(previewAfter(spine(), PATH, [{ op: "set", path: "actors[id=A99].name", value: "X" }])).toBeNull()
  })
})

describe("C-5 redo ≤ 2 rồi sửa tay", () => {
  it(`trượt lần 1, 2 ⇒ AI làm lại; từ lần ${MAX_REDO_PER_LOCATION + 1} ⇒ manual_fix`, () => {
    expect([0, 1, 2, 3].map(nextAfterVerifyFail)).toEqual(["proposing", "proposing", "manual_fix", "manual_fix"])
  })
})
