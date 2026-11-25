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
import { afterAllOps, checkLocation, checkRequestDone, checkSpineOps, ownersOfPath, previousFindingsText, previousFlags } from "./verify.service.js"

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

describe("C-5 checkLocation - code (đỏ)", () => {
  it("đạt; chưa kết luận; not_related bỏ qua; phần tử đã xoá ⇒ element_missing", () => {
    expect(checkLocation(cr, loc(), spine(), mine)).toEqual([])
    expect(checkLocation(cr, loc({ conclusion: null }), spine(), mine).map((v) => v.rule)).toEqual(["unconcluded"])
    expect(checkLocation(cr, loc({ conclusion: "not_related", proposal: null }), spine(), new Map())).toEqual([])
    expect(checkLocation(cr, loc({ path: "actors[id=A99]" }), spine(), mine).map((v) => v.rule)).toEqual(["element_missing"])
  })

  it("FLF-375: không còn khoá - CR khác cùng chạm phần tử không làm trượt; thiếu đề xuất ⇒ no_proposal", () => {
    expect(checkLocation(cr, loc(), spine(), new Map([[PATH, "CR-002"]])).map((v) => v.rule)).not.toContain("path_not_locked")
    expect(checkLocation(cr, loc({ proposal: null }), spine(), mine).map((v) => v.rule)).toEqual(["no_proposal"])
  })

  it("edit không op ⇒ edit_without_ops; op không đổi gì ⇒ edit_no_change; op chạm phần tử không khoá ⇒ op_path_not_locked; thêm phần tử mới từ vị trí phần tử ⇒ add_outside_slot (chỉ thêm từ ô thêm mới - 2026-09-24)", () => {
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

  it("giá trị tại path đã đổi kể từ lúc đề xuất (trước khi xác nhận) ⇒ vi phạm value_changed để AI soạn lại (FLF-375)", () => {
    const changed = spine()
    ;(changed.actors[0] as { description: string }).description = "Edited elsewhere"
    expect(checkLocation(cr, loc(), changed, mine)).toEqual([expect.objectContaining({ rule: "value_changed", path: PATH })])
  })
})

describe("C-5 checkSpineOps - op Spine chạy khô", () => {
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

describe("C-5 nhận xét AI lần trước (FLF-307)", () => {
  const flagged = (location_id: string, ai_flags: { rule: string; message: string }[] | null) =>
    ({ location_id, verify: ai_flags ? { code_ok: true, violations: [], ai_flags, at: new Date() } : null }) as Pick<IChangeLocation, "location_id" | "verify">

  it("giữ nhận xét theo vị trí; vị trí vừa đề xuất lại (verify null) không còn nhận xét", () => {
    const prev = previousFlags([flagged("L004", [{ rule: "contradiction", message: "A" }]), flagged("L005", []), flagged("L074", null)])
    expect([...prev.keys()]).toEqual(["L004"])
  })

  it("liệt kê nhận xét cũ không lặp cho prompt; không có ⇒ (none)", () => {
    const same = [{ rule: "contradiction", message: "A" }]
    expect(previousFindingsText(new Map([["L004", same], ["L005", same]]))).toBe("- (contradiction) A")
    expect(previousFindingsText(new Map())).toBe("(none)")
  })
})

describe("FLF-469 A: vi phạm gán đúng vị trí", () => {
  const badEntity = { op: "add", path: "entities[]", value: { id: "E01", name: "Course", description: "x", relations: [], attributes: [{ name: "id", type: "string" }] } }
  const entityLoc = (over: Partial<IChangeLocation> = {}) =>
    loc({ location_id: "L002", path: "entities[]", proposal: { old_text: "[]", new_text: "[]", comment_text: null, spine_ops: [badEntity], ...over.proposal } as never, ...over })

  it("vị trí 2 thêm thực thể sai khuôn ⇒ chỉ vị trí 2 có vi phạm, vị trí 1 sạch", () => {
    const res = checkSpineOps(spine(), cr, [loc({ location_id: "L001" }), entityLoc()])
    expect(res.has("L001")).toBe(false)
    expect(res.get("L002")?.length).toBeGreaterThan(0)
  })

  it("ownersOfPath: path phần tử ⇒ op set cùng phần tử; op add theo value.id; không khớp ⇒ rỗng", () => {
    const ops = [
      { op: "set", path: "actors[id=A01].name", value: "S" },
      { op: "add", path: "entities[]", value: { id: "E01", name: "C", description: "", relations: [] } }
    ] as never[]
    expect(ownersOfPath(ops, ["L001", "L002"], "entities[id=E01].attributes[0]")).toEqual(["L002"])
    expect(ownersOfPath(ops, ["L001", "L002"], "actors[id=A01]")).toEqual(["L001"])
    expect(ownersOfPath(ops, ["L001", "L002"], "E01")).toEqual(["L002"])
    expect(ownersOfPath(ops, ["L001", "L002"], "roles[id=R9]")).toEqual([])
  })

  it("lô trượt không chỉ được vào đâu mà một vị trí chạy khô riêng đã hỏng (new_text null) ⇒ chỉ vị trí đó", () => {
    const broken = loc({ location_id: "L002", path: "actors[id=A02]", proposal: proposal({ new_text: null, spine_ops: [{ op: "set", path: "actors[id=A99].name", value: "X" }] }) })
    const res = checkSpineOps(spine(), cr, [loc({ location_id: "L001" }), broken])
    expect(res.has("L001")).toBe(false)
    expect(res.has("L002")).toBe(true)
  })
})

describe("FLF-469 C: kiểm đối chiếu yêu cầu bằng code", () => {
  const withFn = (): Spine => {
    const s = spine()
    s.functions.push({ id: "FR-3.3.5", name: "Gửi tin nhắn Trò chuyện với Shop", screen_id: null, feature_id: "F1", order: 0, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null } as never)
    return s
  }
  const removeCr = { title: "Bỏ chức năng 3.3.5 Gửi tin nhắn Trò chuyện với Shop", description: "", amendments: [], clarifications: [], targets: { entity_paths: ["functions[id=FR-3.3.5]"] } } as never
  const note = (path: string) => loc({ location_id: "L007", path, conclusion: "comment", proposal: proposal({ new_text: null, spine_ops: [], comment_text: "Không có thao tác nào để xoá" }) })

  it("CR xoá chức năng mà chức năng còn sau lô ⇒ request_not_done ở vị trí của nó", () => {
    const s = withFn()
    const res = checkRequestDone(removeCr, s, afterAllOps(s, cr, [note("functions[id=FR-3.3.5]")]), [note("functions[id=FR-3.3.5]")])
    expect(res.get("L007")?.map((v) => v.rule)).toEqual(["request_not_done"])
  })

  it("xoá thật bằng op remove ⇒ đạt", () => {
    const s = withFn()
    const l = loc({ location_id: "L007", path: "functions[id=FR-3.3.5]", proposal: proposal({ spine_ops: [{ op: "remove", path: "functions[id=FR-3.3.5]" }], new_text: "" }) })
    expect(checkRequestDone(removeCr, s, afterAllOps(s, cr, [l]), [l]).size).toBe(0)
  })

  it("CR thêm chức năng mà mọi vị trí là ghi chú ⇒ chặn; có op add vào functions[] ⇒ đạt; ý yếu (cho phép) có sửa khác ⇒ không chặn", () => {
    const s = withFn()
    const addCr = { title: "Thêm một chức năng đổi địa chỉ giao hàng", description: "", amendments: [], clarifications: [], targets: { entity_paths: [] } } as never
    const slot = loc({ location_id: "L001", path: "functions[]", conclusion: "comment", proposal: proposal({ new_text: null, spine_ops: [], comment_text: "Hãy thêm chức năng này" }) })
    expect(checkRequestDone(addCr, s, s, [slot]).get("L001")?.[0]?.rule).toBe("request_not_done")
    const done = loc({ location_id: "L001", path: "functions[]", proposal: proposal({ spine_ops: [{ op: "add", path: "functions[]", value: { id: "FR-9" } }], new_text: "[]" }) })
    expect(checkRequestDone(addCr, s, s, [done]).size).toBe(0)
    const weakCr = { title: "Cho phép người mua đổi địa chỉ", description: "", amendments: [], clarifications: [], targets: { entity_paths: ["feature:F1"] } } as never
    expect(checkRequestDone(weakCr, s, s, [loc()]).size).toBe(0)
    expect(checkRequestDone(weakCr, s, s, [slot]).size).toBe(1)
  })
})
