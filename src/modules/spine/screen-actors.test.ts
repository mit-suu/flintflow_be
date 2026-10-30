import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { hasScreenActorLinks, screenActorMap, screenLanes } from "./screen-actors.js"
import type { Spine } from "./spine.types.js"

const fn = (id: string, screenId: string | null) =>
  ({ id, screen_id: screenId, feature_id: "F1", order: 0, name: id, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }) as Spine["functions"][number]
const uc = (id: string, actor_ids: string[], function_ids: string[]) => ({ id, name: id, actor_ids, function_ids, description: "", includes: [], extends: [] })

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

describe("screenLanes", () => {
  it("màn → primary_function_id → function → use case → actor_ids; bỏ actor system", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01"), fn("FN2", "S01")]
    s.use_cases = [uc("UC1", ["A03", "A01"], ["FN1"]), uc("UC2", ["A02"], ["FN2"])]
    // FN2 không phải primary ⇒ A02 không vào làn của S01
    expect(screenLanes(s).get("S01")).toEqual({ actorId: "A01", ambiguous: [] })
    expect(Object.fromEntries(screenActorMap(s))).toEqual({ S01: ["A01"], S02: [], S03: [] })
    expect(hasScreenActorLinks(screenActorMap(s))).toBe(true)
  })

  it("không có primary function ⇒ mọi function có screen_id = màn", () => {
    const s = base()
    s.functions = [fn("FN1", "S02")]
    s.use_cases = [uc("UC1", ["A02"], ["FN1"])]
    expect(screenLanes(s).get("S02")?.actorId).toBe("A02")
  })

  it("primary function không thuộc use case nào ⇒ lùi về function khác của màn rồi quyền", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01"), fn("FN2", "S01")]
    s.use_cases = [uc("UC2", ["A02"], ["FN2"])]
    expect(screenLanes(s).get("S01")?.actorId).toBe("A02")

    s.use_cases = []
    s.roles = [{ id: "R1", name: "Customer", actor_id: "A01" }, { id: "R2", name: "Guest", actor_id: null }]
    s.permissions = [{ id: "P1", screen_id: "S01", role_id: "R1", action: "view" }, { id: "P2", screen_id: "S03", role_id: "R2", action: "view" }]
    expect(screenLanes(s).get("S01")?.actorId).toBe("A01")
    // role không gắn actor ⇒ màn không có actor nào (không còn luật "màn public thuộc mọi actor")
    expect(screenLanes(s).get("S03")).toBeNull()
  })

  it("actor cùng cha ⇒ làn của actor cha, không bung xuống actor lá", () => {
    const s = base()
    s.actors.push({ id: "A04", name: "User", kind: "human", description: "" })
    s.actors[0].parent_id = "A04"
    s.actors[1].parent_id = "A04"
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01")]
    s.use_cases = [uc("UC1", ["A01", "A02"], ["FN1"]), uc("UC2", ["A04"], ["FN1"])]
    expect(screenLanes(s).get("S01")).toEqual({ actorId: "A04", ambiguous: [] })
    s.use_cases = [uc("UC1", ["A01", "A02"], ["FN1"])]
    expect(screenLanes(s).get("S01")).toEqual({ actorId: "A04", ambiguous: [] })
  })

  it("nhiều actor không có tổ tiên chung ⇒ mơ hồ, chọn actor đầu tiên theo thứ tự actor_ids", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01")]
    s.use_cases = [uc("UC1", ["A02", "A01"], ["FN1"])]
    expect(screenLanes(s).get("S01")).toEqual({ actorId: "A02", ambiguous: ["A02", "A01"] })
  })

  it("chưa có liên kết nào ⇒ hasScreenActorLinks = false", () => {
    expect(hasScreenActorLinks(screenActorMap(base()))).toBe(false)
  })
})
