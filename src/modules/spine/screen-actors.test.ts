import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { guestOpenScreenIds, hasScreenActorLinks, screenActorMap } from "./screen-actors.js"
import type { Spine } from "./spine.types.js"

const base = (): Spine => {
  const s = createEmptySpine()
  s.actors = [
    { id: "A01", name: "Customer", kind: "human", description: "" },
    { id: "A02", name: "Staff", kind: "human", description: "" },
    { id: "A03", name: "Payment Gateway", kind: "system", description: "" }
  ]
  s.screens = ["S01", "S02", "S03"].map((id, i) => ({
    id,
    feature_id: "F1",
    name: id,
    description: "",
    flow_to: [],
    is_popup: false,
    tabs: [],
    primary_function_id: null,
    queue_order: i + 1,
    detail_status: "placeholder" as const
  }))
  return s
}

describe("screenActorMap", () => {
  it("gộp actor người từ quyền (role.actor_id) và use case ↔ function trên màn; bỏ actor system", () => {
    const s = base()
    s.roles = [{ id: "R1", name: "Staff", actor_id: "A02" }]
    s.permissions = [{ id: "P1", screen_id: "S02", role_id: "R1", action: "view" }]
    s.functions = [
      { id: "FN1", screen_id: "S01", feature_id: "F1", order: 0, name: "Pay", trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }
    ] as Spine["functions"]
    s.use_cases = [{ id: "UC1", name: "Pay", actor_ids: ["A03", "A01"], function_ids: ["FN1"], description: "", includes: [], extends: [] }]

    const map = screenActorMap(s)
    expect(Object.fromEntries(map)).toEqual({ S01: ["A01"], S02: ["A02"], S03: [] })
    expect(hasScreenActorLinks(map)).toBe(true)
  })

  it("màn chỉ role không gắn actor (Guest) được vào ⇒ thuộc mọi actor người đã có màn", () => {
    const s = base()
    s.roles = [
      { id: "R1", name: "Staff", actor_id: "A02" },
      { id: "R2", name: "Guest", actor_id: null }
    ]
    s.permissions = [
      { id: "P1", screen_id: "S01", role_id: "R2", action: "view" },
      { id: "P2", screen_id: "S02", role_id: "R1", action: "view" },
      // S03: Guest lẫn Staff ⇒ không phải màn public
      { id: "P3", screen_id: "S03", role_id: "R2", action: "view" },
      { id: "P4", screen_id: "S03", role_id: "R1", action: "view" }
    ]
    s.functions = [
      { id: "FN1", screen_id: "S03", feature_id: "F1", order: 0, name: "Pay", trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }
    ] as Spine["functions"]
    s.use_cases = [{ id: "UC1", name: "Pay", actor_ids: ["A01"], function_ids: ["FN1"], description: "", includes: [], extends: [] }]

    expect(Object.fromEntries(screenActorMap(s))).toEqual({ S01: ["A01", "A02"], S02: ["A02"], S03: ["A01", "A02"] })
  })

  it("màn public khi chưa actor nào có màn ⇒ không gán; quyền trỏ role không tồn tại không làm màn thành public", () => {
    const s = base()
    s.roles = [{ id: "R2", name: "Guest", actor_id: null }]
    s.permissions = [
      { id: "P1", screen_id: "S01", role_id: "R2", action: "view" },
      { id: "P2", screen_id: "S02", role_id: "R9", action: "view" }
    ]
    expect(hasScreenActorLinks(screenActorMap(s))).toBe(false)

    s.roles.push({ id: "R1", name: "Staff", actor_id: "A02" })
    s.permissions.push({ id: "P3", screen_id: "S03", role_id: "R1", action: "view" })
    expect(Object.fromEntries(screenActorMap(s))).toEqual({ S01: ["A02"], S02: [], S03: ["A02"] })
  })

  it("guestOpenScreenIds: màn có ít nhất một quyền của role không gắn actor (kể cả khi role khác cũng vào)", () => {
    const s = base()
    s.roles = [
      { id: "R1", name: "Staff", actor_id: "A02" },
      { id: "R2", name: "Guest", actor_id: null }
    ]
    s.permissions = [
      { id: "P1", screen_id: "S01", role_id: "R2", action: "view" },
      { id: "P2", screen_id: "S01", role_id: "R1", action: "view" },
      { id: "P3", screen_id: "S02", role_id: "R1", action: "view" },
      { id: "P4", screen_id: "S03", role_id: "R9", action: "view" }
    ]
    expect([...guestOpenScreenIds(s)]).toEqual(["S01"])
  })

  it("chưa có quyền lẫn use case gắn function ⇒ không có liên kết nào", () => {
    expect(hasScreenActorLinks(screenActorMap(base()))).toBe(false)
  })
})
