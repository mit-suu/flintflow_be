/**
 * FLF-307: id trùng trong op `add` của CR được đổi sang id chưa dùng (dự án "xoài", CR-001: AI đặt `UC-91`, `SCR-84`
 * đã có ⇒ C-5 trượt `duplicate_id` mãi).
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation } from "./change-location.model.js"
import { reassignDuplicateIds } from "./new-ids.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Xoài" })
  s.use_cases.push(...(["UC-78", "UC-91", "UC-125", "UC-1", "UC-14"].map((id) => ({ id, name: id })) as never[]))
  s.screens.push(...(["SCR-01", "SCR-84"].map((id) => ({ id, name: id })) as never[]))
  return s
}

type Loc = Pick<IChangeLocation, "location_id" | "conclusion" | "proposal">
const loc = (location_id: string, spine_ops: unknown[], conclusion: Loc["conclusion"] = "edit"): Loc => ({
  location_id,
  conclusion,
  proposal: { old_text: "", new_text: null, comment_text: null, spine_ops, assumptions: [] }
})

describe("reassignDuplicateIds", () => {
  it("id trùng phần tử có sẵn ⇒ id kế tiếp theo khuôn của tài liệu", () => {
    const l = loc("L074", [{ op: "add", path: "use_cases[]", value: { id: "UC-91", name: "Quên mật khẩu" } }])
    expect(reassignDuplicateIds(spine(), [l])).toEqual([l])
    expect((l.proposal!.spine_ops[0] as { value: { id: string } }).value.id).toBe("UC-126")
  })

  it("tham chiếu id cũ trong op add khác của CR đổi theo; op set giữ nguyên; không thay chuỗi con", () => {
    const screens = loc("L075", [{ op: "add", path: "screens[]", value: { id: "SCR-84", name: "Reset Password", flow_to: ["SCR-01"] } }])
    const perms = loc("L077", [
      { op: "add", path: "permissions[]", value: { id: "P100", role_id: "R05", screen_id: "SCR-84", action: "access" } },
      { op: "set", path: "screens[id=SCR-01].flow_to", value: ["SCR-84"] }
    ])
    const changed = reassignDuplicateIds(spine(), [screens, perms])
    expect(changed).toEqual([screens, perms])
    expect(screens.proposal!.spine_ops[0]).toMatchObject({ value: { id: "SCR-85", flow_to: ["SCR-01"] } })
    expect(perms.proposal!.spine_ops[0]).toMatchObject({ value: { screen_id: "SCR-85" } })
    expect(perms.proposal!.spine_ops[1]).toEqual({ op: "set", path: "screens[id=SCR-01].flow_to", value: ["SCR-84"] })
  })

  it("hai vị trí cùng thêm một id mới ⇒ vị trí sau lấy id khác", () => {
    const a = loc("L001", [{ op: "add", path: "use_cases[]", value: { id: "UC-126", name: "A" } }])
    const b = loc("L002", [{ op: "add", path: "use_cases[]", value: { id: "UC-126", name: "B" } }])
    reassignDuplicateIds(spine(), [a, b])
    expect(a.proposal!.spine_ops[0]).toMatchObject({ value: { id: "UC-126" } })
    expect(b.proposal!.spine_ops[0]).toMatchObject({ value: { id: "UC-127" } })
  })

  it("id không trùng, id tạm, không id, vị trí không phải edit ⇒ không đổi gì", () => {
    const ops = [
      { op: "add", path: "use_cases[]", value: { id: "UC-200", name: "A" } },
      { op: "add", path: "use_cases[]", value: { id: "$new1", name: "B" } },
      { op: "add", path: "use_cases[]", value: { name: "C" } }
    ]
    const before = JSON.stringify(ops)
    expect(reassignDuplicateIds(spine(), [loc("L001", ops), loc("L002", [{ op: "add", path: "use_cases[]", value: { id: "UC-91" } }], "comment")])).toEqual([])
    expect(JSON.stringify(ops)).toBe(before)
  })
})
