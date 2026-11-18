import { describe, it, expect } from "vitest"
import { buildPendingQueue } from "./pending-queue.service.js"
import { createEmptySpine } from "./spine.repository.js"
import type { Assumption, Flag, Screen, Spine } from "./spine.types.js"

const spineAt = (phase: string): Spine => {
  const spine = createEmptySpine({ name: "P" })
  spine.progress.current_phase = phase
  return spine
}

const assumption = (id: string, over: Partial<Assumption> = {}): Assumption => ({
  id,
  path: "functions[id=FN3].normal",
  statement: "s",
  rationale: "r",
  origin_step_id: "B-1.2",
  status: "unconfirmed",
  confirmed_at: null,
  ...over
})

const screen = (id: string, over: Partial<Screen> = {}): Screen => ({
  id,
  feature_id: "F1",
  name: id,
  description: "",
  flow_to: [],
  is_popup: false,
  tabs: [],
  primary_function_id: null,
  queue_order: null,
  detail_status: "pending",
  ...over
})

const flag = (id: string, over: Partial<Flag> = {}): Flag => ({
  id,
  level: "yellow",
  rule_id: "some_rule",
  section_id: "fixed:5.2",
  target_id: null,
  message: "m",
  remediation_step: "S-7.2",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...over
})

const note = (id: string, target_section = "fixed:5.4") => ({
  id,
  topic: "t",
  content: "c",
  content_en: "c",
  target_section,
  captured_at: "2026-11-18T00:00:00.000Z"
})

describe("buildPendingQueue - phạm vi theo pha", () => {
  it("Brief (B-* và S-1): giả định chưa xác nhận + mọi ghi chú; giả định đã xác nhận bị bỏ", () => {
    for (const phase of ["B-1", "S-1"]) {
      const spine = spineAt(phase)
      spine.assumptions = [assumption("AS1"), assumption("AS2", { status: "confirmed" })]
      spine.addendum = [note("AD1")]
      const q = buildPendingQueue(spine)
      expect(q.items.map((i) => i.key), phase).toEqual(["assumption:AS1", "brief_note:AD1"])
      expect(q.total).toBe(2)
    }
  })

  it("ngoài Brief không có giả định / ghi chú; ngoài S-5 không có màn", () => {
    const spine = spineAt("S-3")
    spine.assumptions = [assumption("AS1")]
    spine.addendum = [note("AD1")]
    spine.screens = [screen("S1")]
    expect(buildPendingQueue(spine)).toEqual({ total: 0, items: [] })
  })

  it("S-5: màn pending thành việc screen, owner_step là bước đầu vòng của màn", () => {
    const spine = spineAt("S-5")
    spine.screens = [screen("S1", { detail_status: "signed_off" }), screen("S2", { primary_function_id: "FN9" })]
    const q = buildPendingQueue(spine)
    expect(q.items).toEqual([
      {
        key: "screen:S2",
        kind: "screen",
        blocking: true,
        owner_step: "S-5.1@S2",
        section_id: "function:FN9",
        entity_path: "screens[id=S2]",
        dependents: 0,
        refs: { screen_id: "S2" }
      }
    ])
  })

  it("brief_note: owner_step theo section đích, entity_path addendum[id=X]", () => {
    const spine = spineAt("B-2")
    spine.addendum = [note("AD1", "fixed:5.4")]
    const [item] = buildPendingQueue(spine).items
    expect(item.owner_step).toBe("S-7.4")
    expect(item.section_id).toBe("fixed:5.4")
    expect(item.entity_path).toBe("addendum[id=AD1]")
    expect(item.refs).toEqual({ addendum_id: "AD1" })
  })

  it("giả định: owner_step = origin_step_id, entity_path từ assumption.path", () => {
    const spine = spineAt("B-2")
    spine.assumptions = [assumption("AS1", { path: "project.vision", origin_step_id: "B-1.3" })]
    const [item] = buildPendingQueue(spine).items
    expect(item.owner_step).toBe("B-1.3")
    expect(item.entity_path).toBe("project.vision")
  })
})

describe("buildPendingQueue - cờ", () => {
  it("cờ đỏ mở thành flag_red; đã resolve hoặc đã giữ nguyên thì bỏ", () => {
    const spine = spineAt("S-9")
    spine.flags = [
      flag("F1", { level: "red", target_id: "FN3", remediation_step: "S-4.1" }),
      flag("F2", { level: "red", resolved_at: "2026-11-18T00:00:00.000Z" }),
      flag("F3", { level: "red", kept_reason: "giữ vì lý do dài hơn hai mươi ký tự" })
    ]
    spine.functions = [{ id: "FN3" } as Spine["functions"][number]]
    const q = buildPendingQueue(spine)
    expect(q.items).toHaveLength(1)
    expect(q.items[0]).toMatchObject({ key: "flag_red:F1", kind: "flag_red", blocking: true, owner_step: "S-4.1", entity_path: "functions[id=FN3]", refs: { flag_ids: ["F1"] } })
  })

  it("S-9: unconfirmed_assumption / screen_pending_at_baseline đổi thành assumption / screen, bỏ trùng", () => {
    const spine = spineAt("S-9")
    spine.assumptions = [assumption("AS1")]
    spine.screens = [screen("S4", { primary_function_id: "FN2" })]
    spine.flags = [
      flag("F1", { level: "red", rule_id: "unconfirmed_assumption", target_id: "AS1", section_id: "fixed:5.4", remediation_step: "S-9.2" }),
      flag("F2", { level: "red", rule_id: "screen_pending_at_baseline", target_id: "S4", remediation_step: "S-5.1@S4" }),
      flag("F3", { level: "red", rule_id: "screen_pending_at_baseline", target_id: "S4", remediation_step: "S-5.1@S4" })
    ]
    const q = buildPendingQueue(spine)
    expect(q.items.map((i) => [i.key, i.kind, i.owner_step])).toEqual([
      ["assumption:AS1", "assumption", "B-1.2"],
      ["screen:S4", "screen", "S-5.1@S4"]
    ])
  })

  it("cờ unconfirmed_assumption trỏ giả định không còn ⇒ giữ là flag_red", () => {
    const spine = spineAt("S-9")
    spine.flags = [flag("F1", { level: "red", rule_id: "unconfirmed_assumption", target_id: "GONE", remediation_step: "S-9.2" })]
    expect(buildPendingQueue(spine).items[0]).toMatchObject({ kind: "flag_red", entity_path: null })
  })

  it("giả định đã đổi từ cờ không bị đếm hai lần ở Brief", () => {
    const spine = spineAt("S-1")
    spine.assumptions = [assumption("AS1")]
    spine.flags = [flag("F1", { level: "red", rule_id: "unconfirmed_assumption", target_id: "AS1", remediation_step: "S-9.2" })]
    expect(buildPendingQueue(spine).items.map((i) => i.key)).toEqual(["assumption:AS1"])
  })

  it("cờ vàng gom theo phần tử đã chuẩn hoá: id trần, path thô, ref path cùng một nhóm", () => {
    const spine = spineAt("S-7")
    spine.functions = [{ id: "FN3" } as Spine["functions"][number]]
    spine.flags = [
      flag("F1", { target_id: "FN3", rule_id: "r1" }),
      flag("F2", { target_id: "functions[id=FN3].normal", rule_id: "r2" }),
      flag("F3", { target_id: "functions[id=FN3]", rule_id: "r3", waived_by_user: true }),
      flag("F4", { target_id: "FN3", rule_id: "r4", resolved_at: "2026-11-18T00:00:00.000Z" })
    ]
    const q = buildPendingQueue(spine)
    expect(q.items).toHaveLength(1)
    expect(q.items[0]).toMatchObject({
      key: "flag_yellow_group:functions[id=FN3]",
      kind: "flag_yellow_group",
      blocking: false,
      entity_path: "functions[id=FN3]",
      refs: { flag_ids: ["F1", "F2"] }
    })
  })

  it("cờ vàng không chuẩn hoá được gom theo rule_id@section_id, entity_path null", () => {
    const spine = spineAt("S-7")
    spine.flags = [
      flag("F1", { target_id: "actors[kind=human]", rule_id: "r1", section_id: "fixed:2.1" }),
      flag("F2", { target_id: null, rule_id: "r1", section_id: "fixed:2.1" }),
      flag("F3", { target_id: null, rule_id: "r1", section_id: "fixed:5.2" })
    ]
    const q = buildPendingQueue(spine)
    expect(q.items.map((i) => i.key)).toEqual(["flag_yellow_group:r1@fixed:2.1", "flag_yellow_group:r1@fixed:5.2"])
    expect(q.items.every((i) => i.entity_path === null && i.dependents === 0)).toBe(true)
    expect(q.items[0].refs.flag_ids).toEqual(["F1", "F2"])
  })
})

describe("buildPendingQueue - thứ tự và dependents", () => {
  it("loại → bước soạn → section → id; bước lạ đứng sau bước biết", () => {
    const spine = spineAt("S-5")
    spine.screens = [screen("S10"), screen("S2")]
    spine.flags = [
      flag("Y1", { target_id: null, rule_id: "y", section_id: "fixed:5.2", remediation_step: "S-7.2" }),
      flag("R2", { level: "red", remediation_step: "S-6.1", section_id: "fixed:4.1" }),
      flag("R1", { level: "red", remediation_step: "S-3.1", section_id: "fixed:2.1" }),
      flag("R3", { level: "red", remediation_step: "S-99.9", section_id: "fixed:4.1" })
    ]
    const keys = buildPendingQueue(spine).items.map((i) => i.key)
    expect(keys).toEqual(["screen:S2", "screen:S10", "flag_red:R1", "flag_red:R2", "flag_red:R3", "flag_yellow_group:y@fixed:5.2"])
  })

  it("dependents: số việc cùng phần tử có bước soạn sau; cờ vàng cùng phần tử đã gộp thành một nhóm", () => {
    const spine = spineAt("S-1")
    spine.functions = [{ id: "FN3" } as Spine["functions"][number]]
    spine.assumptions = [assumption("AS1", { path: "functions[id=FN3].normal", origin_step_id: "B-1.2" })]
    spine.flags = [
      flag("R1", { level: "red", target_id: "FN3", remediation_step: "S-4.1" }),
      flag("Y1", { target_id: "functions[id=FN3].alt", remediation_step: "S-5.2@S1" })
    ]
    const byKey = Object.fromEntries(buildPendingQueue(spine).items.map((i) => [i.key, i.dependents]))
    expect(byKey["assumption:AS1"]).toBe(2)
    expect(byKey["flag_red:R1"]).toBe(1)
    expect(byKey["flag_yellow_group:functions[id=FN3]"]).toBe(0)
  })

  it("450 cờ vàng: gom trong bộ nhớ, nhanh", () => {
    const spine = spineAt("S-7")
    spine.flags = Array.from({ length: 450 }, (_, i) => flag(`F${i}`, { rule_id: `r${i % 9}`, section_id: `fixed:5.${(i % 5) + 1}` }))
    const started = performance.now()
    const q = buildPendingQueue(spine)
    expect(performance.now() - started).toBeLessThan(500)
    expect(q.total).toBeGreaterThan(0)
    expect(q.items.reduce((n, i) => n + (i.refs.flag_ids?.length ?? 0), 0)).toBe(450)
  })
})
