import { describe, it, expect } from "vitest"
import { createEmptySpine } from "./spine.repository.js"
import { hasScreenActorLinks, screenActorMap, screenActorSets, sharedScreenIds } from "./screen-actors.js"
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

describe("screenActorSets / screenActorMap", () => {
  it("màn → primary_function_id → function → use case → actor_ids; bỏ actor system", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01"), fn("FN2", "S01")]
    s.use_cases = [uc("UC1", ["A03", "A01"], ["FN1"]), uc("UC2", ["A02"], ["FN2"])]
    // FN2 không phải primary ⇒ A02 không dùng S01
    expect(screenActorSets(s).get("S01")).toEqual(["A01"])
    expect(Object.fromEntries(screenActorMap(s))).toEqual({ S01: ["A01"], S02: [], S03: [] })
    expect(hasScreenActorLinks(screenActorMap(s))).toBe(true)
  })

  it("không có primary function ⇒ mọi function có screen_id = màn", () => {
    const s = base()
    s.functions = [fn("FN1", "S02")]
    s.use_cases = [uc("UC1", ["A02"], ["FN1"])]
    expect(screenActorMap(s).get("S02")).toEqual(["A02"])
  })

  it("primary function không thuộc use case nào ⇒ lùi về function khác của màn rồi quyền", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01"), fn("FN2", "S01")]
    s.use_cases = [uc("UC2", ["A02"], ["FN2"])]
    expect(screenActorMap(s).get("S01")).toEqual(["A02"])

    s.use_cases = []
    s.roles = [{ id: "R1", name: "Customer", actor_id: "A01" }, { id: "R2", name: "Guest", actor_id: null }]
    s.permissions = [{ id: "P1", screen_id: "S01", role_id: "R1", action: "view" }, { id: "P2", screen_id: "S03", role_id: "R2", action: "view" }]
    expect(screenActorMap(s).get("S01")).toEqual(["A01"])
    // role không gắn actor ⇒ màn không có actor nào (không còn luật "màn public thuộc mọi actor")
    expect(screenActorSets(s).get("S03")).toEqual([])
  })

  it("actor cùng cha ⇒ đại diện là actor cha, không bung xuống actor lá", () => {
    const s = base()
    s.actors.push({ id: "A04", name: "User", kind: "human", description: "" })
    s.actors[0].parent_id = "A04"
    s.actors[1].parent_id = "A04"
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01")]
    s.use_cases = [uc("UC1", ["A01", "A02"], ["FN1"]), uc("UC2", ["A04"], ["FN1"])]
    expect(screenActorMap(s).get("S01")).toEqual(["A04"])
    s.use_cases = [uc("UC1", ["A01", "A02"], ["FN1"])]
    expect(screenActorMap(s).get("S01")).toEqual(["A04"])
  })

  it("nhiều actor không có tổ tiên chung ⇒ đại diện là actor đầu tiên theo thứ tự actor_ids; tập actor giữ đủ", () => {
    const s = base()
    s.screens[0].primary_function_id = "FN1"
    s.functions = [fn("FN1", "S01")]
    s.use_cases = [uc("UC1", ["A02", "A01"], ["FN1"])]
    expect(screenActorMap(s).get("S01")).toEqual(["A02"])
    expect(screenActorSets(s).get("S01")).toEqual(["A02", "A01"])
  })

  it("chưa có liên kết nào ⇒ hasScreenActorLinks = false", () => {
    expect(hasScreenActorLinks(screenActorMap(base()))).toBe(false)
  })
})

describe("sharedScreenIds", () => {
  const linked = (): Spine => {
    const s = base()
    s.screens.forEach((x, i) => (x.primary_function_id = `FN${i + 1}`))
    s.functions = [fn("FN1", "S01"), fn("FN2", "S02"), fn("FN3", "S03")]
    return s
  }

  it("mọi actor người lá dùng màn ⇒ dùng chung; thiếu một actor ⇒ không", () => {
    const s = linked()
    s.use_cases = [uc("UC1", ["A01", "A02", "A03"], ["FN1"]), uc("UC2", ["A01"], ["FN2"])]
    expect([...sharedScreenIds(s)]).toEqual(["S01"])
  })

  it("actor tổng quát phủ các actor con; actor tổng quát không cần có mặt khi đủ con", () => {
    const s = linked()
    s.actors.push({ id: "A04", name: "User", kind: "human", description: "" })
    s.actors[0].parent_id = "A04"
    s.actors[1].parent_id = "A04"
    s.use_cases = [uc("UC1", ["A04"], ["FN1"]), uc("UC2", ["A01", "A02"], ["FN2"]), uc("UC3", ["A02"], ["FN3"])]
    expect([...sharedScreenIds(s)].sort()).toEqual(["S01", "S02"])
  })

  it("chưa có liên kết màn ↔ actor ⇒ không màn nào dùng chung", () => {
    expect(sharedScreenIds(base()).size).toBe(0)
  })
})
