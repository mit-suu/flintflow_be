import { describe, expect, it } from "vitest"
import { sha256, unchangedSince, valueText } from "../modules/change-request/spine-location.js"
import { createEmptySpine } from "../modules/spine/spine.repository.js"
import { compactSet } from "./compact-cr-array-locations.js"

describe("compactSet — rút gọn vị trí arr[] cũ (FLF-308)", () => {
  const before = valueText([{ id: "SCR-01", name: "Login" }])
  const after = valueText([{ id: "SCR-01", name: "Login" }, { id: "SCR-85", name: "Reset" }])

  it("cũ ⇒ trước [], sau chỉ phần tử thêm, base_hash = sha256(old_text cũ)", () => {
    expect(compactSet({ path: "screens[]", proposal: { old_text: before, new_text: after } })).toEqual({
      "proposal.old_text": "[]",
      "proposal.new_text": valueText([{ id: "SCR-85", name: "Reset" }]),
      "proposal.base_hash": sha256(before)
    })
  })

  it("kiểm 'chưa bị sửa' cho cùng kết quả trước và sau khi rút gọn", () => {
    const spine = createEmptySpine()
    spine.screens.push({ id: "SCR-01", name: "Login" } as never)
    const set = compactSet({ path: "screens[]", proposal: { old_text: before, new_text: after } })!
    expect(unchangedSince(spine, "screens[]", { old_text: before })).toBe(true)
    expect(unchangedSince(spine, "screens[]", { old_text: "[]", base_hash: set["proposal.base_hash"] })).toBe(true)
  })

  it("phần tử / đã gọn / chưa có đề xuất ⇒ bỏ qua", () => {
    expect(compactSet({ path: "actors[id=A01]", proposal: { old_text: "{}", new_text: "{}" } })).toBeNull()
    expect(compactSet({ path: "screens[]", proposal: { old_text: "[]", new_text: "[]", base_hash: "h" } })).toBeNull()
    expect(compactSet({ path: "screens[]", proposal: null })).toBeNull()
  })
})
