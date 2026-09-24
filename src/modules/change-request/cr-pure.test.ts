import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { locationPromptText, matchProposals } from "./propose.service.js"

describe("matchProposals — ghép output C-4 với vị trí của lô", () => {
  const batch = [
    { location_id: "L005", path: "actors[id=A01]" },
    { location_id: "L006", path: "use_cases[id=UC-01]" }
  ]
  const out = (location_id: string) => ({ location_id, conclusion: "edit" as const, reason: "r", spine_ops: [], assumptions: [] })

  it("khớp đúng location_id", () => {
    const m = matchProposals(batch, [out("L006"), out("L005")])
    expect(m.get(batch[0])?.location_id).toBe("L005")
    expect(m.get(batch[1])?.location_id).toBe("L006")
  })

  it("model trả path thay location_id vẫn khớp", () => {
    expect(matchProposals(batch, [out("use_cases[id=UC-01]")]).get(batch[1])).toBeDefined()
  })

  it("model đánh số lại (L001, L002 cho lô L005, L006) ⇒ ghép theo thứ tự khi số lượng bằng nhau (lỗi thấy khi e2e P3)", () => {
    const m = matchProposals(batch, [out("L001"), out("L002")])
    expect(m.size).toBe(2)
    expect(m.get(batch[0])?.location_id).toBe("L001")
  })

  it("số output lạ khác số vị trí thiếu ⇒ không đoán, để thiếu", () => {
    const m = matchProposals(batch, [out("L005"), out("L009"), out("L010")])
    expect(m.size).toBe(1)
    expect(m.has(batch[1])).toBe(false)
  })
})

describe("locationPromptText — vị trí trong prompt C-4", () => {
  it("mã vị trí + path + section + lý do tìm thấy + giá trị hiện tại (JSON); lần làm lại kèm lỗi trước", () => {
    const s = createEmptySpine({ name: "Lumen" })
    s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "" } as never)
    const text = locationPromptText(s, {
      location_id: "L001",
      path: "actors[id=A01]",
      section_id: "fixed:2.1",
      found_by: ["spine_link"],
      entity_paths: ["actors[id=A01]"],
      verify: { code_ok: false, violations: [{ rule: "edit_no_change", message: "Op không đổi gì" }], ai_flags: [], at: new Date() }
    })
    expect(text.split("\n")[0]).toBe("[L001] actors[id=A01] (section: Actors; found by spine_link; about actors[id=A01])")
    expect(text).toContain('"name": "Learner"')
    expect(text).toContain("Previous proposal failed checks: Op không đổi gì")
  })
})
