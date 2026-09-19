import { describe, expect, it } from "vitest"
import { textHash } from "../docx-ooxml/index.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { elementPathOf, findLocations } from "./cr-impact.service.js"
import { checkLocation, checkSpineOps } from "./verify.service.js"

const block = (block_id: string, text: string, section_id: string | null = null, mentions: { entity: string; id: string }[] = []) => ({
  block_id,
  text,
  section_id,
  mentions,
  anchor: { ordinal: Number(block_id.slice(1)) }
})

describe("C-3 findLocations", () => {
  it("hợp ba nguồn, khử trùng, owner step theo section", () => {
    const blocks = [
      block("B0001", "UC-01 Register account", "fixed:2.2.2", [{ entity: "use_case", id: "UC-01" }]),
      block("B0002", "Learner logs out of the system", "function:FR-3.2.4"),
      block("B0003", "Sign out ends the session", "fixed:5.2"),
      block("B0004", "Unrelated text", "fixed:1")
    ]
    const found = findLocations(
      blocks,
      ["use_cases[id=UC-01]", "functions[id=FR-3.2.4]"],
      new Map([["use_cases[id=UC-01]", ["B0001", "B9999"]]]),
      ["sign out", "ok"],
      (s) => `owner:${s}`
    )
    expect(found).toEqual([
      { block_id: "B0001", found_by: ["spine_link", "mention"], entity_paths: ["use_cases[id=UC-01]"], owner_step: "owner:fixed:2.2.2" },
      { block_id: "B0002", found_by: ["spine_link"], entity_paths: ["functions[id=FR-3.2.4]"], owner_step: "owner:function:FR-3.2.4" },
      { block_id: "B0003", found_by: ["keyword"], entity_paths: [], owner_step: "owner:fixed:5.2" }
    ])
    expect(elementPathOf("use_cases[id=UC-01].name")).toBe("use_cases[id=UC-01]")
    expect(elementPathOf("project.vision")).toBeNull()
  })
})

describe("C-5 kiểm tất định", () => {
  const cr = { cr_id: "CR-001" } as IChangeRequest
  const loc = (over: Partial<IChangeLocation>): IChangeLocation =>
    ({ location_id: "L001", block_id: "B0001", conclusion: "edit", proposal: { old_text: "Old text", new_text: "New text", comment_text: null, spine_ops: [] }, ...over }) as IChangeLocation
  const b = (text: string, locked: string | null = "CR-001") => ({ block_id: "B0001", text, text_hash: textHash(text), locked_by_cr: locked, section_id: null, anchor: { ordinal: 0 } })

  it("đạt; không khoá; edit không đổi; comment rỗng; chưa kết luận", () => {
    expect(checkLocation(cr, loc({}), b("Old text"))).toEqual([])
    expect(checkLocation(cr, loc({}), b("Old text", "CR-002")).map((v) => v.rule)).toEqual(["block_not_locked"])
    expect(checkLocation(cr, loc({ proposal: { old_text: "Old text", new_text: "Old  text", comment_text: null, spine_ops: [] } }), b("Old text")).map((v) => v.rule)).toEqual(["edit_no_change"])
    expect(checkLocation(cr, loc({ conclusion: "comment", proposal: { old_text: "Old text", new_text: null, comment_text: " ", spine_ops: [] } }), b("Old text")).map((v) => v.rule)).toEqual(["comment_empty"])
    expect(checkLocation(cr, loc({ conclusion: null }), b("Old text")).map((v) => v.rule)).toEqual(["unconcluded"])
    expect(checkLocation(cr, loc({ conclusion: "not_related" }), undefined)).toEqual([])
  })

  it("text block đã đổi ⇒ CR_OLD_TEXT_MISMATCH", () => {
    expect(() => checkLocation(cr, loc({}), b("Changed meanwhile"))).toThrow(expect.objectContaining({ code: "CR_OLD_TEXT_MISMATCH" }))
  })

  it("op Spine sai / phá bất biến ⇒ vi phạm gắn đúng vị trí", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const res = checkSpineOps(spine, cr, [
      loc({ location_id: "L001", proposal: { old_text: "a", new_text: "b", comment_text: null, spine_ops: [{ op: "set", path: "actors[id=A99].name", value: "X" }] } }),
      loc({ location_id: "L002", proposal: { old_text: "a", new_text: "b", comment_text: null, spine_ops: [{ nope: true }] } }),
      loc({ location_id: "L003", conclusion: "not_related", proposal: { old_text: "a", new_text: null, comment_text: null, spine_ops: [{ op: "set", path: "x", value: 1 }] } })
    ])
    expect([...res.keys()].sort()).toEqual(["L001", "L002"])
    expect(res.get("L002")?.[0].rule).toBe("op_invalid")
  })
})
