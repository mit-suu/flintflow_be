import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { hasScreenActorLinks, screenActorMap } from "./screen-actors.js"
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

  it("chưa có quyền lẫn use case gắn function ⇒ không có liên kết nào", () => {
    expect(hasScreenActorLinks(screenActorMap(base()))).toBe(false)
  })
})
