/**
 * FLF-308: vị trí "thêm mới" (`arr[]`) không chép cả mảng vào `old_text` / `new_text` / `current_text` — dự án "xoài"
 * có `functions[]` 111 KB, request CR ~550 KB. Mảng lúc đề xuất giữ bằng `base_hash`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { shownTexts } from "./change-request.service.js"
import { valueOps } from "./location.service.js"
import { previewAfter } from "./propose.service.js"
import { addedElements, currentText, elementValue, snapshotOf, unchangedSince, valueText } from "./spine-location.js"
import { checkLocation } from "./verify.service.js"

const uc = (id: string, name = id) => ({ id, name, actor_ids: ["A01"], description: "", extends: [], includes: [], function_ids: [] })
const spine = (): Spine => {
  const s = createEmptySpine({ name: "Xoài" })
  s.actors.push({ id: "A01", name: "Student", kind: "human", description: "" } as never)
  s.use_cases.push(...(["UC-78", "UC-125"].map((id) => uc(id)) as never[]))
  return s
}
const SLOT = "use_cases[]"
const ADD = [{ op: "add", path: SLOT, value: uc("UC-126", "Forgot password") }]

describe("snapshotOf / unchangedSince", () => {
  it("vị trí arr[] ⇒ old_text \"[]\" + base_hash; phần tử ⇒ cả giá trị, không hash", () => {
    const s = spine()
    expect(snapshotOf(s, SLOT)).toEqual({ old_text: "[]", base_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(snapshotOf(s, "actors[id=A01]")).toEqual({ old_text: valueText(elementValue(s, "actors[id=A01]")), base_hash: null })
  })

  it("mảng bị sửa ở chỗ khác sau lúc chụp ⇒ không còn khớp", () => {
    const s = spine()
    const snap = snapshotOf(s, SLOT)
    expect(unchangedSince(s, SLOT, snap)).toBe(true)
    s.use_cases.push(uc("UC-200") as never)
    expect(unchangedSince(s, SLOT, snap)).toBe(false)
  })

  it("bản ghi cũ (old_text là cả mảng, chưa có base_hash) vẫn so được", () => {
    const s = spine()
    const legacy = { old_text: valueText(elementValue(s, SLOT)) }
    expect(unchangedSince(s, SLOT, legacy)).toBe(true)
    s.use_cases.pop()
    expect(unchangedSince(s, SLOT, legacy)).toBe(false)
  })

  it("current_text của vị trí arr[] là \"[]\"", () => {
    expect(currentText(spine(), SLOT)).toBe("[]")
    expect(currentText(spine(), "actors[id=A01]")).toContain('"name": "Student"')
  })
})

describe("new_text của vị trí arr[] = chỉ phần tử thêm mới", () => {
  it("previewAfter: chỉ UC-126, không kèm UC-78 / UC-125; không op ⇒ []", () => {
    const after = JSON.parse(previewAfter(spine(), SLOT, ADD)!)
    expect(after.map((u: { id: string }) => u.id)).toEqual(["UC-126"])
    expect(previewAfter(spine(), SLOT, [])).toBe("[]")
  })

  it("addedElements khớp theo id, phần tử không id theo giá trị", () => {
    expect(addedElements([{ id: "A" }, "x"], [{ id: "A", name: "đổi" }, { id: "B" }, "x", "y"])).toEqual([{ id: "B" }, "y"])
  })

  it("C-5: thêm UC-126 ⇒ đạt; mảng đổi ở chỗ khác sau lúc đề xuất ⇒ CR_VALUE_CHANGED", () => {
    const s = spine()
    const cr = { cr_id: "CR-002" } as IChangeRequest
    const locks = new Map([[SLOT, "CR-002"]])
    const loc = (spine_ops: unknown[]) => ({
      location_id: "L074",
      path: SLOT,
      conclusion: "edit" as const,
      proposal: { ...snapshotOf(s, SLOT), new_text: previewAfter(s, SLOT, spine_ops), comment_text: null, spine_ops, assumptions: [] }
    })
    const proposed = loc(ADD)
    expect(proposed.proposal.new_text).toContain("UC-126")
    expect(checkLocation(cr, proposed, s, locks)).toEqual([])
    s.use_cases.push(uc("UC-200") as never)
    expect(() => checkLocation(cr, proposed, s, locks)).toThrow(/đã bị sửa ở chỗ khác/)
  })
})

describe("Tự sửa vị trí arr[] (valueOps)", () => {
  it("danh sách phần tử mới ⇒ mỗi phần tử một op add; phần tử ⇒ set", () => {
    expect(valueOps(SLOT, [{ name: "A" }, { name: "B" }])).toEqual([
      { op: "add", path: SLOT, value: { name: "A" } },
      { op: "add", path: SLOT, value: { name: "B" } }
    ])
    expect(valueOps("actors[id=A01]", { name: "X" })).toEqual([{ op: "set", path: "actors[id=A01]", value: { name: "X" } }])
  })
})

describe("toDetail rút gọn bản ghi arr[] cũ (shownTexts)", () => {
  it("bản ghi cũ chép cả mảng ⇒ trước [], sau chỉ phần tử thêm; bản ghi mới / phần tử giữ nguyên", () => {
    const s = spine()
    const before = valueText(elementValue(s, SLOT))
    const afterAll = valueText([...s.use_cases, uc("UC-126")])
    expect(shownTexts(SLOT, { old_text: before, new_text: afterAll })).toEqual({ old_text: "[]", new_text: valueText([uc("UC-126")]) })
    expect(shownTexts(SLOT, { old_text: "[]", new_text: "[1]", base_hash: "h" })).toEqual({ old_text: "[]", new_text: "[1]" })
    expect(shownTexts("actors[id=A01]", { old_text: "a", new_text: "b" })).toEqual({ old_text: "a", new_text: "b" })
  })
})
