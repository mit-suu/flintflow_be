import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { allocateId } from "./id-allocator.js"
import { planTransaction } from "./op-engine.js"
import { resolve, selectorFor } from "./path-resolver.js"
import { findDeadReferences } from "./reference-fields.js"
import { renderedDiagramHash } from "./source-hash.js"
import { spineSchema } from "./spine.schema.js"
import type { Entity, Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const entityOf = (spine: Spine, id: string): Entity => spine.entities.find((e) => e.id === id)!
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const plan = (ops: unknown[], spine: Spine = FIXTURE) => planTransaction(spine, txn(ops), { startSeq: 1 }).spine
const KEY = "entities[id=E01].transitions[from=E01-ST1,to=E01-ST2,event=verify email]"

describe("entities[].states / transitions — schema", () => {
  it("fixture có vòng đời cho User và Baseline; Spine cũ thiếu hai field vẫn hợp lệ", () => {
    expect(entityOf(FIXTURE, "E01").states?.map((s) => s.name)).toEqual(["Pending", "Active", "Suspended", "Deactivated"])
    expect(entityOf(FIXTURE, "E08").transitions?.[0]).toMatchObject({ event: "sign", business_rule_ids: ["BR03"] })
    const old = structuredClone(FIXTURE) as unknown as { entities: Record<string, unknown>[] }
    for (const e of old.entities) {
      delete e.states
      delete e.transitions
    }
    const parsed = spineSchema.parse(old)
    expect(entityOf(parsed, "E01").states).toBeUndefined()
  })

  it("strict: key lạ, tên state rỗng, event rỗng hoặc chứa , [ ] bị từ chối", () => {
    const bad = (patch: (e: { states: Record<string, unknown>[]; transitions: Record<string, unknown>[] }) => void) => {
      const s = structuredClone(FIXTURE) as unknown as { entities: { states: Record<string, unknown>[]; transitions: Record<string, unknown>[] }[] }
      patch(s.entities[0])
      return spineSchema.safeParse(s).success
    }
    expect(bad(() => undefined)).toBe(true)
    expect(bad((e) => (e.states[0].colour = "red"))).toBe(false)
    expect(bad((e) => (e.states[0].name = "  "))).toBe(false)
    expect(bad((e) => (e.transitions[0].event = ""))).toBe(false)
    for (const event of ["a, b", "a [b]", "a]"]) expect(bad((e) => (e.transitions[0].event = event)), event).toBe(false)
  })
})

describe("op engine — states / transitions", () => {
  it("selectorFor: transition chọn theo from + to + event (không rơi vào khoá `to` của flow_to)", () => {
    const t = entityOf(FIXTURE, "E01").transitions![0]
    expect(selectorFor(t)).toEqual({ kind: "match", pairs: [["from", "E01-ST1"], ["to", "E01-ST2"], ["event", "verify email"]] })
    expect(resolve(FIXTURE, KEY)).toMatchObject({ kind: "element", value: { event: "verify email" } })
  })

  it("sửa guard / action qua path; không đổi được khoá", () => {
    const next = plan([{ op: "set", path: `${KEY}.guard`, value: "code is valid" }])
    expect(entityOf(next, "E01").transitions![0].guard).toBe("code is valid")
    expect(() => plan([{ op: "set", path: `${KEY}.event`, value: "other" }])).toThrow()
  })

  it("add state không có id: server cấp <entity>-ST<n> duy nhất trên toàn Spine; id tạm dùng được ở transition sau", () => {
    expect(allocateId(FIXTURE, "states", "E01")).toBe("E01-ST5")
    expect(allocateId(FIXTURE, "states", "E02")).toBe("E02-ST1")
    expect(allocateId(FIXTURE, "states", null)).toBeNull()
    const next = plan([
      { op: "add", path: "entities[id=E02].states[]", value: { id: "$a", name: "Open", initial: true } },
      { op: "add", path: "entities[id=E02].states[]", value: { id: "$b", name: "Closed", final: true } },
      { op: "add", path: "entities[id=E02].transitions[]", value: { from: "$a", to: "$b", event: "close" } }
    ])
    expect(entityOf(next, "E02").states?.map((s) => s.id)).toEqual(["E02-ST1", "E02-ST2"])
    expect(entityOf(next, "E02").transitions).toEqual([{ from: "E02-ST1", to: "E02-ST2", event: "close" }])
  })

  it("transition trùng khoá bị từ chối khi add; set cả mảng giữ phần tử đầu", () => {
    const dup = { from: "E01-ST1", to: "E01-ST2", event: "verify email" }
    expect(() => plan([{ op: "add", path: "entities[id=E01].transitions[]", value: dup }])).toThrow()
    const next = plan([{ op: "set", path: "entities[id=E01].transitions", value: [dup, { ...dup, guard: "later" }, { from: "E01-ST2", to: "E01-ST3", event: "suspend" }] }])
    expect(entityOf(next, "E01").transitions).toEqual([dup, { from: "E01-ST2", to: "E01-ST3", event: "suspend" }])
  })

  it("remove transition theo khoá", () => {
    const next = plan([{ op: "remove", path: KEY }])
    expect(entityOf(next, "E01").transitions!.some((t) => t.event === "verify email")).toBe(false)
  })
})

describe("tham chiếu và cascade", () => {
  it("from / to / business_rule_ids chết ⇒ dead_reference; fixture không có khoá chết", () => {
    expect(findDeadReferences(FIXTURE).filter((h) => h.field.path.startsWith("entities[].transitions"))).toEqual([])
    const dead = mutate((s) => {
      entityOf(s, "E08").transitions![0].to = "E08-ST9"
      entityOf(s, "E08").transitions![0].business_rule_ids = ["BR99"]
    })
    expect(findDeadReferences(dead).map((h) => h.refPath)).toEqual(
      expect.arrayContaining(["entities[id=E08].transitions[from=E08-ST1,to=E08-ST9,event=sign].to", "entities[id=E08].transitions[from=E08-ST1,to=E08-ST9,event=sign].business_rule_ids[=BR99]"])
    )
  })

  it("xoá state gỡ mọi transition đi vào / đi ra (cả transition nội bộ)", () => {
    const next = plan([{ op: "remove", path: "entities[id=E01].states[id=E01-ST2]" }])
    expect(entityOf(next, "E01").states?.map((s) => s.id)).toEqual(["E01-ST1", "E01-ST3", "E01-ST4"])
    // còn lại: Suspended → Deactivated; các chuyển qua Active đã bị gỡ
    expect(entityOf(next, "E01").transitions).toEqual([{ from: "E01-ST3", to: "E01-ST4", event: "deactivate" }])
  })

  it("xoá business rule gỡ id khỏi transition (không xoá transition)", () => {
    const next = plan([{ op: "remove", path: "business_rules[id=BR03]" }])
    const sign = entityOf(next, "E08").transitions!.find((t) => t.event === "sign")!
    expect(sign.business_rule_ids ?? []).toEqual([])
    expect(entityOf(next, "E08").transitions).toHaveLength(3)
  })

  it("xoá entity xoá luôn hình state_machine của nó (owner_id chết)", () => {
    const withDiagram = mutate((s) =>
      s.diagrams.push({ id: "D90", kind: "state_machine", format: "svg", source: "<svg/>", section: "fixed:3.1.5", owner_kind: "entity", owner_id: "E08", render_status: "ok", source_hash: "x" } as never)
    )
    const next = plan([{ op: "remove", path: "entities[id=E08]" }], withDiagram)
    expect(next.diagrams.some((d) => d.id === "D90")).toBe(false)
  })
})

describe("source hash — state_machine", () => {
  const sm = (owner: string) => ({ kind: "state_machine" as const, owner_id: owner })

  it("hash theo từng entity: đổi state / nhãn transition làm cũ hình entity đó, entity khác thì không", () => {
    const base = renderedDiagramHash(FIXTURE, sm("E01"))
    expect(renderedDiagramHash(structuredClone(FIXTURE), sm("E01"))).toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E01").states![1].name = "Enabled")), sm("E01"))).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E01").transitions![2].guard = "other")), sm("E01"))).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E01").states![3].final = false)), sm("E01"))).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E01").name = "Account")), sm("E01"))).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E01").states![1].name = "Enabled")), sm("E08"))).toBe(renderedDiagramHash(FIXTURE, sm("E08")))
  })

  it("mô tả entity và business_rule_ids không đổi hash (không vẽ lên hình)", () => {
    const base = renderedDiagramHash(FIXTURE, sm("E08"))
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E08").description = "other")), sm("E08"))).toBe(base)
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E08").transitions![0].business_rule_ids = [])), sm("E08"))).toBe(base)
  })

  it("thêm vòng đời không làm ERD / class stale", () => {
    const stripped = mutate((s) =>
      s.entities.forEach((e) => {
        delete e.states
        delete e.transitions
      })
    )
    for (const d of [{ kind: "erd" as const, owner_id: null }, { kind: "class" as const, owner_id: "F1" }]) {
      expect(renderedDiagramHash(FIXTURE, d)).toBe(renderedDiagramHash(stripped, d))
    }
  })
})
