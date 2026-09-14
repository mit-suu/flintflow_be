import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"

/**
 * Model Mongoose thay bằng store trong bộ nhớ (cùng ngữ nghĩa với spine.repository.test.ts):
 * findOneAndUpdate nguyên tử, unique (projectId, seq), deleteMany theo txn.
 */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>

  const spines: Doc[] = []
  const changes: Doc[] = []
  const copy = <X>(x: X): X => structuredClone(x)

  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number; $lte?: number; $in?: unknown[] }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        const n = Number(actual)
        return (e.$gte === undefined || n >= e.$gte) && (e.$lte === undefined || n <= e.$lte)
      }
      return String(actual) === String(expected)
    })
  const bySeq = (a: Doc, b: Doc) => Number(a.seq) - Number(b.seq)

  const Spine = {
    findOne: async (filter: Filter) => copy(spines.find((s) => matches(s, filter)) ?? null),
    exists: async (filter: Filter) => (spines.some((s) => matches(s, filter)) ? { _id: "x" } : null),
    findOneAndUpdate: async (filter: Filter, update: { $set?: Doc; $setOnInsert?: Doc }, options: { upsert?: boolean } = {}) => {
      const doc = spines.find((s) => matches(s, filter))
      if (doc) {
        Object.assign(doc, copy(update.$set ?? {}))
        return copy(doc)
      }
      if (!options.upsert) return null
      const created = { _id: "spine", ...filter, ...copy(update.$setOnInsert ?? {}) }
      spines.push(created)
      return copy(created)
    }
  }
  const Change = {
    findOne: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return copy((options.sort?.seq === -1 ? rows[rows.length - 1] : rows[0]) ?? null)
    },
    find: async (filter: Filter) => changes.filter((c) => matches(c, filter)).sort(bySeq).map(copy),
    insertMany: async (docs: Doc[]) => {
      if (docs.some((d) => changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq))) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async (filter: Filter) => {
      for (let i = changes.length - 1; i >= 0; i--) if (matches(changes[i], filter)) changes.splice(i, 1)
      return {}
    }
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
  }
  return { Spine, Change, spines, changes, reset }
})

vi.mock("./spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("./change.model.js", () => ({ Change: db.Change }))

import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import type { Op, Transaction } from "./op.types.js"
import * as repo from "./spine.repository.js"
import {
  TransactionRejectedError,
  applyTransaction,
  planRevert,
  planTransaction,
  previewTransaction,
  revertRange
} from "./op-engine.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, "../../../fixtures")
const readJson = (...segments: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...segments), "utf8"))

const FIXTURE: Spine = spineSchema.parse(readJson("spine-fixture-19-screens.json"))

const opCaseSchema = z.object({
  name: z.string(),
  step_id: z.string(),
  spine_before_ref: z.string(),
  spine_before_overrides: z.record(z.string(), z.unknown()).optional(),
  expected_ops: z.array(z.object({ op: z.enum(["set", "add", "remove"]), path: z.string(), value: z.unknown().optional(), reason: z.string().optional() })),
  must_reject: z.string().optional()
})
type OpCase = z.infer<typeof opCaseSchema>

const CASES = Array.from({ length: 10 }, (_, i) => {
  const file = `case-${String(i + 1).padStart(2, "0")}.json`
  return { file, opCase: opCaseSchema.parse(readJson("op-cases", file)) }
})

/** Ghi đè path dạng chấm (quy ước fixture T02). */
const baseOf = (opCase: OpCase): Spine => {
  const spine = structuredClone(spineSchema.parse(readJson(opCase.spine_before_ref)))
  for (const [dotted, value] of Object.entries(opCase.spine_before_overrides ?? {})) {
    const keys = dotted.split(".")
    let node = spine as unknown as Record<string, unknown>
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
    node[keys[keys.length - 1]] = value
  }
  return spine
}

const txn = (ops: Op[], extra: Partial<Transaction> = {}): Transaction => ({ base_version: 1, ops, by: "user-1", ...extra })

const rejection = (fn: () => unknown): TransactionRejectedError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof TransactionRejectedError) return err
    throw err
  }
  throw new Error("lẽ ra phải bị từ chối")
}

const without = <T extends { spine_version: number }>({ spine_version: _v, ...rest }: T) => rest

// ─── 10 ca op T02 ────────────────────────────────────────────────

describe("10 ca op T02 (fixtures/op-cases)", () => {
  for (const { file, opCase } of CASES) {
    if (opCase.must_reject) {
      it(`${file} — ${opCase.name}: từ chối ${opCase.must_reject}`, () => {
        const base = baseOf(opCase)
        const err = rejection(() => planTransaction(base, txn(opCase.expected_ops), { startSeq: 1 }))
        expect(err.statusCode).toBe(422)
        expect(err.violations.map((v) => v.rule)).toContain(opCase.must_reject)
      })
      continue
    }

    it(`${file} — ${opCase.name}: áp được, seq liên tục, revert về deep-equal`, () => {
      const base = baseOf(opCase)
      const plan = planTransaction(base, txn(opCase.expected_ops, { step_id: opCase.step_id }), { startSeq: 7 })

      expect(spineSchema.safeParse(plan.spine).success).toBe(true)
      expect(plan.changes.length).toBeGreaterThanOrEqual(opCase.expected_ops.length)
      plan.changes.forEach((c, i) => {
        expect(c.seq).toBe(7 + i)
        expect(c.txn).toBe(plan.txn)
        expect(c.step_id).toBe(opCase.step_id)
        expect(c).toHaveProperty("before")
      })
      expect(plan.spine).not.toEqual(base)

      const changes = plan.changes.map((c) => ({ ...c, projectId: "p" }))
      const reverted = planRevert(plan.spine, changes, { by: "user-1", startSeq: 100 })
      expect(reverted.spine).toEqual(base)
      expect(reverted.changes.every((c) => c.op === "revert")).toBe(true)
    })
  }

  it("không làm đổi Spine đầu vào (deep clone)", () => {
    const base = baseOf(CASES[2].opCase)
    const snapshot = structuredClone(base)
    planTransaction(base, txn(CASES[2].opCase.expected_ops), { startSeq: 1 })
    expect(base).toEqual(snapshot)
  })
})

// ─── cascade ─────────────────────────────────────────────────────

describe("cascade tự sinh đúng lô chuẩn của T02", () => {
  for (const index of [2, 3, 5]) {
    const { file, opCase } = CASES[index]
    it(`${file}: chỉ gửi op đầu ⇒ kết quả giống gửi trọn expected_ops`, () => {
      const base = baseOf(opCase)
      const full = planTransaction(base, txn(opCase.expected_ops), { startSeq: 1 })
      const single = planTransaction(base, txn([opCase.expected_ops[0]]), { startSeq: 1 })
      expect(single.spine).toEqual(full.spine)
      expect(single.changes.length).toBe(full.changes.length)
      expect(single.changes.slice(1).every((c) => c.reason?.startsWith("Cascade") || c.reason?.startsWith("Invariant 8"))).toBe(true)
    })
  }

  it("xoá màn gỡ luôn step @màn, diagram sở hữu, primary_function_id trỏ tới function đã xoá", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "remove", path: "screens[id=S07]" }]), { startSeq: 1 })
    expect(plan.spine.screens.some((s) => s.id === "S07")).toBe(false)
    expect(plan.spine.functions.some((f) => f.screen_id === "S07")).toBe(false)
    expect(plan.spine.steps.some((s) => s.id.endsWith("@S07"))).toBe(false)
    expect(plan.spine.diagrams.some((d) => d.owner_id === "S07")).toBe(false)
    expect(plan.spine.assumptions.some((a) => a.path.startsWith("screens[id=S07]"))).toBe(false)
    for (const s of plan.spine.screens) expect(s.flow_to).not.toContain("S07")
  })

  it("xoá actor đặt roles[].actor_id = null", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "remove", path: "actors[id=A04]" }]), { startSeq: 1 })
    expect(plan.spine.roles.find((r) => r.id === "R4")?.actor_id).toBeNull()
  })

  it("xoá feature còn màn ⇒ từ chối cả lô, trả referrers", () => {
    const err = rejection(() => planTransaction(FIXTURE, txn([{ op: "remove", path: "features[id=F6]" }]), { startSeq: 1 }))
    expect(err.code).toBe("INVARIANT_VIOLATION")
    expect(err.violations.map((v) => v.rule)).toContain("invariant_3_dead_reference")
    expect(err.referrers).toEqual(expect.arrayContaining([{ path: "screens[id=S14].feature_id", id: "F6" }]))
  })

  it("xoá feature rỗng ⇒ renumber các feature sau trong cùng lô", () => {
    const withEmpty = planTransaction(
      FIXTURE,
      txn([{ op: "add", path: "features[]", value: { id: "F9", name: "Empty", order: 6 } }]),
      { startSeq: 1 }
    ).spine
    const moved = planTransaction(withEmpty, txn([{ op: "set", path: "features[id=F9].order", value: 0 }, ...[0, 1, 2, 3, 4, 5].map((o) => ({ op: "set" as const, path: `features[id=F${o + 1}].order`, value: o + 1 }))]), { startSeq: 1 }).spine
    const plan = planTransaction(moved, txn([{ op: "remove", path: "features[id=F9]" }]), { startSeq: 1 })
    expect(plan.spine.features.map((f) => [f.id, f.order])).toEqual(FIXTURE.features.map((f) => [f.id, f.order]))
    expect(plan.changes.filter((c) => c.path.endsWith(".order"))).toHaveLength(6)
  })

  it("hoán vị hai feature trong một lô (bất biến 5 chỉ kiểm cuối lô)", () => {
    const plan = planTransaction(
      FIXTURE,
      txn([
        { op: "set", path: "features[id=F1].order", value: 1 },
        { op: "set", path: "features[id=F2].order", value: 0 }
      ]),
      { startSeq: 1 }
    )
    expect(plan.spine.features.find((f) => f.id === "F1")?.order).toBe(1)
    const err = rejection(() => planTransaction(FIXTURE, txn([{ op: "set", path: "features[id=F1].order", value: 1 }]), { startSeq: 1 }))
    expect(err.violations.map((v) => v.rule)).toContain("invariant_5_feature_order")
  })
})

// ─── op khác ─────────────────────────────────────────────────────

describe("các loại op", () => {
  it("renumber features[] theo danh sách id", () => {
    const plan = planTransaction(FIXTURE, txn([{ op: "renumber", path: "features[]", value: ["F6", "F1"] }]), { startSeq: 1 })
    expect(plan.spine.features.map((f) => [f.id, f.order])).toEqual([
      ["F1", 1],
      ["F2", 2],
      ["F3", 3],
      ["F4", 4],
      ["F5", 5],
      ["F6", 0]
    ])
    expect(plan.changes.every((c) => c.op === "renumber")).toBe(true)
  })

  it("set field optional chưa có rồi revert ⇒ key biến mất lại", () => {
    const nfr = FIXTURE.nfrs.find((n) => n.metric === undefined)
    expect(nfr, "fixture cần một nfr không có metric").toBeDefined()
    const plan = planTransaction(FIXTURE, txn([{ op: "set", path: `nfrs[id=${nfr!.id}].metric`, value: "p95" }]), { startSeq: 1 })
    expect(plan.changes[0].before).toEqual({ _absent: true })
    const reverted = planRevert(plan.spine, plan.changes.map((c) => ({ ...c, projectId: "p" })), { by: "u", startSeq: 2 })
    expect(reverted.spine).toEqual(FIXTURE)
  })

  it("set nguyên phần tử giữ khoá; đổi khoá bị từ chối", () => {
    const actor = FIXTURE.actors[0]
    const ok = planTransaction(FIXTURE, txn([{ op: "set", path: `actors[id=${actor.id}]`, value: { ...actor, name: "Renamed" } }]), { startSeq: 1 })
    expect(ok.spine.actors[0].name).toBe("Renamed")
    const err = rejection(() =>
      planTransaction(FIXTURE, txn([{ op: "set", path: `actors[id=${actor.id}]`, value: { ...actor, id: "A77" } }]), { startSeq: 1 })
    )
    expect(err.violations[0].rule).toBe("key_change_forbidden")
  })

  it("đổi trường nằm trong selector khoá tự nhiên bị từ chối", () => {
    const err = rejection(() =>
      planTransaction(FIXTURE, txn([{ op: "set", path: "permissions[screen_id=S08,role_id=R1,action=view].action", value: "update" }]), { startSeq: 1 })
    )
    expect(err.violations[0]).toMatchObject({ rule: "key_change_forbidden", op_index: 0 })
  })

  it("add trùng id, set mảng thực thể, chỉ số mảng, sai schema đều bị từ chối", () => {
    const rules = [
      [{ op: "add", path: "actors[]", value: { ...FIXTURE.actors[0] } }],
      [{ op: "set", path: "actors", value: [] }],
      [{ op: "set", path: "actors[0].name", value: "x" }],
      [{ op: "set", path: "actors[id=A01].kind", value: "robot" }],
      [{ op: "add", path: "actors[id=A01]", value: {} }],
      [{ op: "set", path: "actors[id=A01].name" }]
    ].map((ops) => rejection(() => planTransaction(FIXTURE, txn(ops as Op[]), { startSeq: 1 })).violations[0].rule)
    expect(rules).toEqual(["duplicate_id", "op_not_allowed", "index_selector_forbidden", "schema_invalid", "op_not_allowed", "op_value_missing"])
  })

  it("không xoá được section bắt buộc và màn đang là screen_cursor", () => {
    const e1 = rejection(() => planTransaction(FIXTURE, txn([{ op: "remove", path: "sections[id=fixed:3.1.1]" }]), { startSeq: 1 }))
    expect(e1.violations.map((v) => v.rule)).toContain("invariant_1_required_section")
    const e8 = rejection(() => planTransaction(FIXTURE, txn([{ op: "remove", path: `screens[id=${FIXTURE.progress.screen_cursor}]` }]), { startSeq: 1 }))
    expect(e8.violations.map((v) => v.rule)).toContain("invariant_8_cursor_screen")
  })

  it("migrate thay toàn bộ nội dung, revert khôi phục", () => {
    const empty = repo.createEmptySpine({ name: "X" })
    const plan = planTransaction(empty, txn([{ op: "migrate", path: "$", value: FIXTURE }]), { startSeq: 1 })
    expect(without(plan.spine)).toEqual(without(FIXTURE))
    const reverted = planRevert(plan.spine, plan.changes.map((c) => ({ ...c, projectId: "p" })), { by: "system", startSeq: 2 })
    expect(reverted.spine).toEqual(empty)
  })

  it("revert gặp giá trị đã bị sửa sau ⇒ revert_conflict, không ghi đè im lặng", () => {
    const first = planTransaction(FIXTURE, txn([{ op: "set", path: "actors[id=A01].name", value: "One" }]), { startSeq: 1 })
    const second = planTransaction(first.spine, txn([{ op: "set", path: "actors[id=A01].name", value: "Two" }]), { startSeq: 2 })
    const err = rejection(() => planRevert(second.spine, first.changes.map((c) => ({ ...c, projectId: "p" })), { by: "u", startSeq: 3 }))
    expect(err.violations[0]).toMatchObject({ rule: "revert_conflict", path: "actors[id=A01].name" })
  })

  it("revert xoá phần tử khi phần tử cùng id đã được thêm lại ⇒ revert_conflict, không chèn trùng", () => {
    const removed = planTransaction(FIXTURE, txn([{ op: "remove", path: "actors[id=A04]" }]), { startSeq: 1 })
    const actor = FIXTURE.actors.find((a) => a.id === "A04")
    const readded = planTransaction(removed.spine, txn([{ op: "add", path: "actors[]", value: actor }]), { startSeq: 10 })
    const err = rejection(() => planRevert(readded.spine, removed.changes.map((c) => ({ ...c, projectId: "p" })), { by: "u", startSeq: 11 }))
    expect(err.violations.map((v) => v.rule)).toContain("revert_conflict")
  })

  it("undo xoá màn trong S-5 khôi phục được (bất biến 8 không coi là màn mới)", () => {
    const base = structuredClone(FIXTURE)
    base.progress.current_phase = "S-5"
    const screen = base.screens.find((s) => s.id !== base.progress.screen_cursor && s.detail_status !== "pending")
    expect(screen, "fixture cần một màn đã mô tả, không phải cursor").toBeDefined()
    const plan = planTransaction(base, txn([{ op: "remove", path: `screens[id=${screen!.id}]` }]), { startSeq: 1 })
    const reverted = planRevert(plan.spine, plan.changes.map((c) => ({ ...c, projectId: "p" })), { by: "u", startSeq: 100 })
    expect(reverted.spine).toEqual(base)
  })

  it("selector vô hướng khớp nhiều bản trùng (dữ liệu legacy) ⇒ lấy bản đầu, không path_ambiguous", () => {
    const base = structuredClone(FIXTURE)
    const screen = base.screens.find((s) => s.flow_to.length > 0)!
    screen.flow_to = [screen.flow_to[0], ...screen.flow_to]
    const plan = planTransaction(base, txn([{ op: "remove", path: `screens[id=${screen.id}].flow_to[=${screen.flow_to[0]}]` }]), { startSeq: 1 })
    expect(plan.spine.screens.find((s) => s.id === screen.id)?.flow_to).toEqual(screen.flow_to.slice(1))
  })

  it("Spine rỗng nhận lô đầu tiên (bất biến 1/2 chỉ chặn việc xoá)", () => {
    const empty = repo.createEmptySpine()
    const plan = planTransaction(empty, txn([{ op: "add", path: "actors[]", value: { id: "A01", name: "User", kind: "human", description: "" } }]), { startSeq: 1 })
    expect(plan.spine.actors).toHaveLength(1)
  })
})

// ─── có DB (model mock) ──────────────────────────────────────────

const PROJECT = "650000000000000000000001"

const seed = async (spine: Spine = FIXTURE) => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...structuredClone(spine) }
}

describe("applyTransaction / previewTransaction / revertRange", () => {
  beforeEach(() => db.reset())

  it("spine_version tăng đúng 1 mỗi txn, changes[] seq liên tục qua nhiều txn", async () => {
    await seed()
    const r1 = await applyTransaction(PROJECT, txn(CASES[2].opCase.expected_ops.slice(0, 1)))
    expect(r1.spine_version).toBe(2)
    const r2 = await applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops, { base_version: 2 }))
    expect(r2.spine_version).toBe(3)

    const all = await repo.listChanges(PROJECT)
    expect(all.map((c) => c.seq)).toEqual(Array.from({ length: all.length }, (_, i) => i + 1))
    expect(new Set(all.map((c) => c.txn))).toEqual(new Set([r1.txn, r2.txn]))
    expect((await repo.get(PROJECT))?.use_cases.find((u) => u.id === "UC05")?.name).toBe("Manage Project Portfolio")
  })

  it("base_version cũ ⇒ 409 SPINE_VERSION_CONFLICT, không ghi change", async () => {
    await seed()
    await applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))
    await expect(applyTransaction(PROJECT, txn(CASES[0].opCase.expected_ops))).rejects.toMatchObject({
      statusCode: 409,
      code: "SPINE_VERSION_CONFLICT"
    })
    expect(await repo.nextSeq(PROJECT)).toBe(2)
  })

  it("2 txn cùng base_version chạy đồng thời ⇒ đúng một thành công, một 409", async () => {
    await seed()
    const results = await Promise.allSettled([
      applyTransaction(PROJECT, txn(CASES[0].opCase.expected_ops)),
      applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))
    ])
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })

    const current = await repo.get(PROJECT)
    expect(current?.spine_version).toBe(2)
    const changes = await repo.listChanges(PROJECT)
    expect(new Set(changes.map((c) => c.txn)).size).toBe(1)
  })

  it("không có transaction: saveWithVersion thua ⇒ 409 và không ghi change nào", async () => {
    await seed()
    // Writer khác đẩy version lên đúng lúc giữa lúc đọc và lúc ghi
    const original = db.Spine.findOneAndUpdate
    db.Spine.findOneAndUpdate = async () => null
    await expect(applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))).rejects.toMatchObject({ statusCode: 409 })
    db.Spine.findOneAndUpdate = original
    expect(db.changes).toHaveLength(0)
  })

  it("không có transaction: seq bị writer khác chiếm sau khi đã lưu Spine ⇒ cấp lại dải seq, không mất change", async () => {
    await seed()
    const original = db.Spine.findOneAndUpdate
    db.Spine.findOneAndUpdate = async (...args: Parameters<typeof original>) => {
      db.Spine.findOneAndUpdate = original
      db.changes.push({ projectId: PROJECT, seq: 1, txn: "other-writer" })
      return original(...args)
    }
    const result = await applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))
    expect(result.spine_version).toBe(2)
    expect(result.changes[0].seq).toBe(2)
    expect(db.changes.filter((c) => c.txn === result.txn).map((c) => c.seq)).toEqual(result.changes.map((c) => c.seq))
    expect(db.changes.some((c) => c.txn === "other-writer")).toBe(true)
  })

  it("lô không đổi gì ⇒ không ghi, không tăng version, txn null", async () => {
    await seed()
    const name = FIXTURE.actors.find((a) => a.id === "A01")!.name
    const result = await applyTransaction(PROJECT, txn([{ op: "set", path: "actors[id=A01].name", value: name }]))
    expect(result).toMatchObject({ txn: null, spine_version: 1, changes: [] })
    expect(db.changes).toHaveLength(0)
  })

  it("preview trên project chưa có Spine dùng Spine rỗng, không tạo Spine", async () => {
    const preview = await previewTransaction(PROJECT, txn([{ op: "set", path: "project.vision", value: "V" }]), { name: "X" })
    expect(preview.ok).toBe(true)
    expect(db.spines).toHaveLength(0)
  })

  it("lô vi phạm bất biến ⇒ 422, DB không đổi", async () => {
    await seed()
    await expect(applyTransaction(PROJECT, txn(CASES[8].opCase.expected_ops))).rejects.toMatchObject({
      statusCode: 422,
      code: "INVARIANT_VIOLATION"
    })
    expect((await repo.get(PROJECT))?.spine_version).toBe(1)
    expect(db.changes).toHaveLength(0)
  })

  it("preview trả diff đầy đủ cascade mà không ghi; vi phạm trả ok=false", async () => {
    await seed()
    const preview = await previewTransaction(PROJECT, txn(CASES[3].opCase.expected_ops.slice(0, 1)))
    expect(preview.ok).toBe(true)
    expect(preview.ops).toHaveLength(3)
    expect(preview.changes.map((c) => c.path)).toEqual(["actors[id=A08]", "use_cases[id=UC01].actor_ids[=A08]", "use_cases[id=UC03].actor_ids[=A08]"])
    expect((await repo.get(PROJECT))?.spine_version).toBe(1)
    expect(db.changes).toHaveLength(0)

    const bad = await previewTransaction(PROJECT, txn(CASES[9].opCase.expected_ops))
    expect(bad.ok).toBe(false)
    expect(bad.violations.map((v) => v.rule)).toContain("invariant_6_feature_mismatch")
  })

  it("revertRange khôi phục Spine deep-equal và ghi op revert trong txn mới", async () => {
    await seed()
    const r1 = await applyTransaction(PROJECT, txn(CASES[2].opCase.expected_ops))
    const r2 = await applyTransaction(PROJECT, txn(CASES[4].opCase.expected_ops, { base_version: 2 }))
    const first = r1.changes[0].seq
    const last = r2.changes[r2.changes.length - 1].seq

    const reverted = await revertRange(PROJECT, first, last, { by: "user-1", base_version: 3 })
    expect(reverted.spine_version).toBe(4)
    expect(without(reverted.spine)).toEqual({ projectId: PROJECT, ...without(FIXTURE) })
    expect(reverted.changes.every((c) => c.op === "revert" && c.txn === reverted.txn)).toBe(true)
    expect(reverted.changes[0].seq).toBe(last + 1)

    // revert của revert đưa về trạng thái sau r2
    const again = await revertRange(PROJECT, reverted.changes[0].seq, reverted.changes[reverted.changes.length - 1].seq, { by: "user-1" })
    expect(without(again.spine)).toEqual(without(r2.spine))
  })

  it("revertRange dải thiếu ⇒ 422 CHANGE_RANGE_INVALID", async () => {
    await seed()
    await applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))
    await expect(revertRange(PROJECT, 1, 5, { by: "u" })).rejects.toMatchObject({ statusCode: 422, code: "CHANGE_RANGE_INVALID" })
    await expect(revertRange(PROJECT, 3, 1, { by: "u" })).rejects.toMatchObject({ code: "CHANGE_RANGE_INVALID" })
  })

  it("project chưa có Spine ⇒ 404", async () => {
    await expect(applyTransaction(PROJECT, txn(CASES[1].opCase.expected_ops))).rejects.toMatchObject({ statusCode: 404 })
  })
})
