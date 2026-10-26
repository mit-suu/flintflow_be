import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "./spine.schema.js"
import { planTransaction } from "./op-engine.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { computeSectionStates } from "./section-status.js"
import { normalizeUseCaseBatch } from "./use-case-propagation.js"
import { isSelfContainedBatch, reacceptOps } from "./reviewed-batch.js"

/** FLF-318: lô thêm use case đã duyệt qua bản xem trước không để lại section `stale`; lô sửa văn xuôi cũ thì vẫn để. */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const S07_FLOW = FIXTURE.screens.find((s) => s.id === "S07")?.flow_to ?? []

const addUseCase = (): Op[] =>
  normalizeUseCaseBatch(FIXTURE, [
    { op: "add", path: "use_cases[]", value: { name: "Send Absence Warning", actor_ids: ["A02"], function_ids: ["$newFn"], description: "Warns absent students." } },
    { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Absence Warning", description: "Warn students.", feature_id: "F3", flow_to: [], tabs: [] } },
    {
      op: "add",
      path: "functions[]",
      value: { id: "$newFn", name: "Send Warning", screen_id: "$newScreen", feature_id: "F3", trigger: "Click Send", description: "Sends warning.", normal: ["a"], abnormal: ["b"], validations: [{ kind: "required", statement: "Pick a student." }] }
    },
    { op: "set", path: "screens[id=S07].flow_to", value: [...S07_FLOW, "$newScreen"] },
    { op: "add", path: "permissions[]", value: { screen_id: "$newScreen", role_id: "R2", action: "view" } },
    { op: "add", path: "messages[]", value: { code: "E-WARN-001", text: "Select at least one student.", function_ids: ["$newFn"] } }
  ])

/** Seq của lô lớn hơn mọi `last_seq` trong fixture (mọi step đã accepted trước lô). */
const plan = (spine: Spine, ops: Op[], startSeq: number) => planTransaction(spine, { base_version: spine.spine_version, ops, by: "u1", step_id: null }, { startSeq })
const staleIds = (spine: Spine, changes: Parameters<typeof computeSectionStates>[1]) => computeSectionStates(spine, changes).filter((s) => s.status === "stale").map((s) => s.id)

describe("isSelfContainedBatch", () => {
  it("thêm phần tử mới + field của phần tử mới + nối thêm flow_to ⇒ chỉ thêm", () => {
    const p = plan(FIXTURE, addUseCase(), 100_000)
    expect(isSelfContainedBatch(FIXTURE, p.spine, p.changes)).toBe(true)
  })

  it("có sửa văn xuôi của phần tử có sẵn ⇒ không phải chỉ thêm", () => {
    const uc = FIXTURE.use_cases[0]
    const p = plan(FIXTURE, [...addUseCase(), { op: "set", path: `use_cases[id=${uc.id}].description`, value: `${uc.description} (edited)` }], 100_000)
    expect(isSelfContainedBatch(FIXTURE, p.spine, p.changes)).toBe(false)
  })

  it("flow_to bị bớt cạnh cũ ⇒ không phải chỉ thêm", () => {
    const p = plan(FIXTURE, [{ op: "set", path: "screens[id=S07].flow_to", value: S07_FLOW.slice(1) }], 100_000)
    expect(isSelfContainedBatch(FIXTURE, p.spine, p.changes)).toBe(false)
  })
})

describe("reacceptOps", () => {
  it("lô thêm use case làm vài section stale ⇒ ghi lại accepted_at của step sở hữu ⇒ không còn section stale mới", () => {
    const batch = plan(FIXTURE, addUseCase(), 100_000)
    const before = staleIds(FIXTURE, [])
    expect(staleIds(batch.spine, batch.changes).filter((id) => !before.includes(id)).length).toBeGreaterThan(0)

    const ops = reacceptOps(FIXTURE, [], batch.spine, batch.changes, "2026-10-24T00:00:00.000Z")
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every((o) => /^steps\[id=[^\]]+\]\.accepted_at$/.test(o.path))).toBe(true)
    const reaccepted = plan(batch.spine, ops, 200_000)
    expect(staleIds(reaccepted.spine, [...batch.changes, ...reaccepted.changes]).filter((id) => !before.includes(id))).toEqual([])
  })

  it("section đã stale từ trước lô ⇒ không đụng tới", () => {
    // A01 đổi tên trước lô ⇒ §2.1 (và section đọc actor) stale; lô thêm use case không được gỡ chỗ đó
    const earlier = plan(FIXTURE, [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }], 100_000)
    const wasStale = staleIds(earlier.spine, earlier.changes)
    expect(wasStale.length).toBeGreaterThan(0)
    const batch = plan(earlier.spine, addUseCase(), 110_000)
    const all = [...earlier.changes, ...batch.changes]
    const ops = reacceptOps(earlier.spine, earlier.changes, batch.spine, all, "2026-10-24T00:00:00.000Z")
    const reaccepted = plan(batch.spine, ops, 200_000)
    const after = staleIds(reaccepted.spine, [...all, ...reaccepted.changes])
    for (const id of wasStale) expect(after).toContain(id)
  })
})

describe("lô xoá use case trọn gói (luật 3g)", () => {
  /** Dự án đã có use case mới của `addUseCase` (đã duyệt), giờ xoá nó cùng chức năng, màn, thông báo chỉ thuộc nó. */
  const withNewUseCase = () => plan(FIXTURE, addUseCase(), 100_000)
  const removeOps = (spine: Spine): Op[] => {
    const uc = spine.use_cases.find((u) => u.name === "Send Absence Warning")!
    const fn = spine.functions.find((f) => f.id === uc.function_ids[0])!
    const msg = spine.messages.find((m) => m.code === "E-WARN-001")!
    return [
      { op: "remove", path: `use_cases[id=${uc.id}]` },
      { op: "remove", path: `functions[id=${fn.id}]` },
      { op: "remove", path: `screens[id=${fn.screen_id}]` },
      { op: "remove", path: `messages[id=${msg.id}]` }
    ]
  }

  it("xoá trọn phần tử + cascade gỡ tham chiếu (flow_to, quyền, bố cục) ⇒ trọn gói", () => {
    const base = withNewUseCase()
    const removal = plan(base.spine, removeOps(base.spine), 150_000)
    expect(removal.spine.use_cases.length).toBe(FIXTURE.use_cases.length)
    expect(isSelfContainedBatch(base.spine, removal.spine, removal.changes)).toBe(true)
  })

  it("xoá kèm sửa văn xuôi của use case còn lại ⇒ không trọn gói", () => {
    const base = withNewUseCase()
    const uc = FIXTURE.use_cases[0]
    const removal = plan(base.spine, [...removeOps(base.spine), { op: "set", path: `use_cases[id=${uc.id}].description`, value: "Edited." }], 150_000)
    expect(isSelfContainedBatch(base.spine, removal.spine, removal.changes)).toBe(false)
  })

  it("sau lô xoá trọn gói ghi lại accepted_at ⇒ không còn section stale mới", () => {
    const base = withNewUseCase()
    const accepted = plan(base.spine, reacceptOps(FIXTURE, [], base.spine, base.changes, "2026-10-24T00:00:00.000Z"), 120_000)
    const history = [...base.changes, ...accepted.changes]
    const before = staleIds(accepted.spine, history)
    const removal = plan(accepted.spine, removeOps(accepted.spine), 150_000)
    const all = [...history, ...removal.changes]
    expect(staleIds(removal.spine, all).filter((id) => !before.includes(id)).length).toBeGreaterThan(0)
    const ops = reacceptOps(accepted.spine, history, removal.spine, all, "2026-10-24T01:00:00.000Z")
    const after = plan(removal.spine, ops, 200_000)
    expect(staleIds(after.spine, [...all, ...after.changes]).filter((id) => !before.includes(id))).toEqual([])
  })
})
