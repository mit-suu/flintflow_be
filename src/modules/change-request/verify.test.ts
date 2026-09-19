/**
 * C-5 kiểm đề xuất — phần hàm thuần (`checkLocation`, `checkSpineOps`, `nextAfterVerifyFail`). FLF-172, plan §8.3.
 * Luồng verify trên DB (AI chỉ vàng, redo ≤ 2 ⇒ manual_fix, pause) ở `test/integration/mode1/verify.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { textHash } from "../docx-ooxml/index.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { MAX_REDO_PER_LOCATION, nextAfterVerifyFail } from "./change-request.state.js"
import { checkLocation, checkSpineOps } from "./verify.service.js"

const cr = { cr_id: "CR-001" } as IChangeRequest
const proposal = (over: Partial<NonNullable<IChangeLocation["proposal"]>> = {}) => ({ old_text: "Old text", new_text: "New text", comment_text: null, spine_ops: [], ...over })
const loc = (over: Partial<IChangeLocation> = {}): IChangeLocation =>
  ({ location_id: "L001", block_id: "B0001", conclusion: "edit", proposal: proposal(), ...over }) as IChangeLocation
const blk = (text: string, locked: string | null = "CR-001") => ({ block_id: "B0001", text, text_hash: textHash(text), locked_by_cr: locked, section_id: null, anchor: { ordinal: 0 } })

describe("C-5 checkLocation — code (đỏ)", () => {
  it("block không còn trong version ⇒ block_missing (edit/comment); not_related thì bỏ qua", () => {
    expect(checkLocation(cr, loc(), undefined).map((v) => v.rule)).toEqual(["block_missing"])
    expect(checkLocation(cr, loc({ conclusion: "comment" }), undefined).map((v) => v.rule)).toEqual(["block_missing"])
    expect(checkLocation(cr, loc({ conclusion: "not_related", proposal: null }), blk("x", null))).toEqual([])
  })

  it("thiếu đề xuất ⇒ no_proposal (kèm block_not_locked nếu mất khoá)", () => {
    expect(checkLocation(cr, loc({ proposal: null }), blk("Old text")).map((v) => v.rule)).toEqual(["no_proposal"])
    expect(checkLocation(cr, loc({ proposal: null }), blk("Old text", null)).map((v) => v.rule)).toEqual(["block_not_locked", "no_proposal"])
  })

  it("edit không có new_text ⇒ edit_without_text", () => {
    expect(checkLocation(cr, loc({ proposal: proposal({ new_text: null }) }), blk("Old text")).map((v) => v.rule)).toEqual(["edit_without_text"])
  })

  it("edit chỉ khác khoảng trắng ⇒ edit_no_change; comment có nội dung ⇒ đạt", () => {
    expect(checkLocation(cr, loc({ proposal: proposal({ new_text: "  Old   text " }) }), blk("Old text")).map((v) => v.rule)).toEqual(["edit_no_change"])
    expect(checkLocation(cr, loc({ conclusion: "comment", proposal: proposal({ new_text: null, comment_text: "Xem lại" }) }), blk("Old text"))).toEqual([])
  })

  it("old text lệch text block ⇒ ném CR_OLD_TEXT_MISMATCH kèm vị trí (kể cả với comment)", () => {
    expect(() => checkLocation(cr, loc({ conclusion: "comment", proposal: proposal({ old_text: "Stale", comment_text: "c" }) }), blk("Old text"))).toThrow(
      expect.objectContaining({ code: "CR_OLD_TEXT_MISMATCH", meta: { location_id: "L001", block_id: "B0001" } })
    )
  })

  it("vi phạm cộng dồn: mất khoá + edit không đổi", () => {
    expect(checkLocation(cr, loc({ proposal: proposal({ new_text: "Old text" }) }), blk("Old text", "CR-002")).map((v) => v.rule)).toEqual([
      "block_not_locked",
      "edit_no_change"
    ])
  })
})

describe("C-5 checkSpineOps — op Spine chạy khô", () => {
  const spine = (): Spine => {
    const s = createEmptySpine({ name: "Lumen" })
    s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "" } as Spine["actors"][number])
    return s
  }

  it("không op ⇒ không vi phạm; vị trí not_related / thiếu đề xuất bị bỏ qua", () => {
    expect(checkSpineOps(spine(), cr, [loc(), loc({ location_id: "L002", conclusion: "not_related", proposal: proposal({ spine_ops: [{ op: "set", path: "x", value: 1 }] }) })]).size).toBe(0)
    expect(checkSpineOps(spine(), cr, [loc({ proposal: null })]).size).toBe(0)
  })

  it("op hợp lệ ⇒ không vi phạm", () => {
    const res = checkSpineOps(spine(), cr, [loc({ proposal: proposal({ spine_ops: [{ op: "set", path: "actors[id=A01].name", value: "Student" }] }) })])
    expect(res.size).toBe(0)
  })

  it("op phá bất biến ⇒ vi phạm gắn đúng vị trí sinh op (op_index), vị trí khác sạch", () => {
    const res = checkSpineOps(spine(), cr, [
      loc({ location_id: "L001", proposal: proposal({ spine_ops: [{ op: "set", path: "actors[id=A01].name", value: "Student" }] }) }),
      loc({ location_id: "L002", conclusion: "comment", proposal: proposal({ comment_text: "c", spine_ops: [{ op: "set", path: "actors[id=A99].name", value: "X" }] }) })
    ])
    expect([...res.keys()]).toEqual(["L002"])
    expect(res.get("L002")!.length).toBeGreaterThan(0)
  })

  it("op sai định dạng ⇒ op_invalid, op hợp lệ còn lại vẫn chạy khô", () => {
    const res = checkSpineOps(spine(), cr, [loc({ proposal: proposal({ spine_ops: [{ nope: 1 }, { op: "set", path: "actors[id=A01].name", value: "Student" }] }) })])
    expect(res.get("L001")?.map((v) => v.rule)).toEqual(["op_invalid"])
  })
})

describe("C-5 redo ≤ 2 rồi sửa tay", () => {
  it(`trượt lần 1, 2 ⇒ AI làm lại; từ lần ${MAX_REDO_PER_LOCATION + 1} ⇒ manual_fix`, () => {
    expect([0, 1, 2, 3].map(nextAfterVerifyFail)).toEqual(["proposing", "proposing", "manual_fix", "manual_fix"])
  })
})
