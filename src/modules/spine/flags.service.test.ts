import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose — cùng ngữ nghĩa op-engine.test.ts. */
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
        throw Object.assign(new Error("E11000"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async () => ({})
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
  }
  return { Spine, Change, spines, reset }
})

vi.mock("./spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("./change.model.js", () => ({ Change: db.Change }))

import { spineSchema } from "./spine.schema.js"
import type { Flag, Spine } from "./spine.types.js"
import * as repo from "./spine.repository.js"
import { applyTransaction } from "./op-engine.js"
import { filterFlags, planFlagOps, recompute, waive } from "./flags.service.js"
import type { FlagCandidate } from "./deterministic-check.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"
const REASON = "Khách hàng chấp nhận chưa có số liệu ở vòng một"

const candidate = (over: Partial<FlagCandidate> = {}): FlagCandidate => ({
  level: "red",
  rule_id: "diagram_stale",
  section_id: "fixed:2.2.1",
  target_id: "D02",
  message: "stale",
  remediation_step: "S-3.6",
  ...over
})

const flag = (over: Partial<Flag> = {}): Flag => ({
  id: "FL001",
  level: "red",
  rule_id: "diagram_stale",
  section_id: "fixed:2.2.1",
  target_id: "D02",
  message: "stale",
  remediation_step: "S-3.6",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  ...over
})

const withFlags = (flags: Flag[], version = 5): Spine => ({ ...structuredClone(FIXTURE), flags, spine_version: version })

describe("planFlagOps (thuần)", () => {
  it("mở cờ mới với id FLnnn, opened_at_version = version sau lô", () => {
    const plan = planFlagOps(withFlags([flag({ id: "FL007", resolved_at: "2026-09-01T00:00:00.000Z" })]), [candidate()])
    expect(plan.opened).toEqual(["FL008"])
    expect(plan.ops).toMatchObject([{ op: "add", path: "flags[]", value: { id: "FL008", opened_at_version: 6, resolved_at: null } }])
  })

  it("cờ còn điều kiện không đổi gì; hết điều kiện thì đóng", () => {
    expect(planFlagOps(withFlags([flag()]), [candidate()]).ops).toEqual([])
    const plan = planFlagOps(withFlags([flag()]), [], new Date("2026-09-14T10:00:00.000Z"))
    expect(plan.resolved).toEqual(["FL001"])
    expect(plan.ops).toMatchObject([{ op: "set", path: "flags[id=FL001].resolved_at", value: "2026-09-14T10:00:00.000Z" }])
  })

  it("waiver hết hạn khi version đổi mà điều kiện còn ⇒ mở lại cùng dòng", () => {
    const plan = planFlagOps(withFlags([flag({ waived_by_user: true, waive_reason: REASON, waived_at_version: 3 })], 5), [candidate()])
    expect(plan.reopened).toEqual(["FL001"])
    expect(plan.ops.map((o) => [o.path, o.value])).toEqual([
      ["flags[id=FL001].waived_by_user", false],
      ["flags[id=FL001].waive_reason", null],
      ["flags[id=FL001].waived_at_version", null]
    ])
  })

  it("waiver còn hiệu lực được đẩy version khi lô có ghi flag khác", () => {
    const spine = withFlags([flag({ waived_by_user: true, waive_reason: REASON, waived_at_version: 5 }), flag({ id: "FL002", target_id: "D03" })], 5)
    expect(planFlagOps(spine, [candidate(), candidate({ target_id: "D03" })]).ops).toEqual([])
    const plan = planFlagOps(spine, [candidate()])
    expect(plan.resolved).toEqual(["FL002"])
    expect(plan.ops).toContainEqual(expect.objectContaining({ path: "flags[id=FL001].waived_at_version", value: 6 }))
  })

  it("filterFlags theo level/open", () => {
    const flags = [flag(), flag({ id: "FL002", level: "yellow" }), flag({ id: "FL003", resolved_at: "2026-09-01T00:00:00.000Z" })]
    expect(filterFlags(flags, { level: "red", open: true }).map((f) => f.id)).toEqual(["FL001"])
    expect(filterFlags(flags, { open: false }).map((f) => f.id)).toEqual(["FL003"])
  })
})

const seed = async (spine: Spine) => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...structuredClone(spine) }
}
const nfrFlag = (flags: Flag[]) => flags.filter((f) => f.rule_id === "nfr_missing_number")
const current = async () => (await repo.get(PROJECT))!

describe("recompute / waive qua op engine", () => {
  beforeEach(() => db.reset())

  it("vòng đời: mở → waive → giữ → hết hạn khi nội dung đổi → đóng → tái phát là dòng mới", async () => {
    await seed({ ...structuredClone(FIXTURE), nfrs: FIXTURE.nfrs.map((n) => (n.id === "N05" ? { ...n, metric: undefined } : n)).map(({ metric, ...rest }) => (metric === undefined ? rest : { ...rest, metric })) })

    const first = await recompute(PROJECT, { by: USER })
    const [opened] = nfrFlag(first.flags)
    expect(opened).toMatchObject({ target_id: "N05", section_id: "fixed:4.2.2", resolved_at: null, opened_at_version: 2 })
    expect(first.checked_at_version).toBe(2)

    const again = await recompute(PROJECT, { by: USER })
    expect(again).toMatchObject({ checked_at_version: 2, opened: [], resolved: [], reopened: [] })

    await expect(waive(PROJECT, opened.id, "ngắn", USER)).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    const waived = await waive(PROJECT, opened.id, REASON, USER)
    expect(waived).toMatchObject({ waived_by_user: true, waive_reason: REASON, waived_at_version: 3 })

    expect((await recompute(PROJECT, { by: USER })).reopened).toEqual([])
    expect((await current()).spine_version).toBe(3)

    await applyTransaction(PROJECT, { base_version: 3, ops: [{ op: "set", path: "entities[id=E01].description", value: "Changed" }], by: USER })
    const lapsed = await recompute(PROJECT, { by: USER })
    expect(lapsed.reopened).toEqual([opened.id])
    expect(nfrFlag(lapsed.flags)[0]).toMatchObject({ id: opened.id, waived_by_user: false, waive_reason: null })

    let version = (await current()).spine_version
    await applyTransaction(PROJECT, { base_version: version, ops: [{ op: "set", path: "nfrs[id=N05].metric", value: "Availability" }], by: USER })
    expect((await recompute(PROJECT, { by: USER })).resolved).toEqual([opened.id])

    version = (await current()).spine_version
    await applyTransaction(PROJECT, { base_version: version, ops: [{ op: "remove", path: "nfrs[id=N05].metric" }], by: USER })
    const recurring = await recompute(PROJECT, { by: USER })
    const rows = nfrFlag(recurring.flags)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: opened.id })
    expect(rows[0].resolved_at).not.toBeNull()
    expect(rows[1]).toMatchObject({ resolved_at: null, waived_by_user: false })
    expect(rows[1].id).not.toBe(opened.id)
  })

  it("waive luật không waive được ⇒ 400 FLAG_NOT_WAIVABLE; cờ không tồn tại ⇒ 404", async () => {
    await seed({ ...structuredClone(FIXTURE), common_requirements: [] })
    const { flags } = await recompute(PROJECT, { by: USER })
    const arrayEmpty = flags.find((f) => f.rule_id === "array_empty")!
    const sectionEmpty = flags.find((f) => f.rule_id === "section_empty")!

    await expect(waive(PROJECT, arrayEmpty.id, REASON, USER)).rejects.toMatchObject({ statusCode: 400, code: "FLAG_NOT_WAIVABLE" })
    await expect(waive(PROJECT, "FL999", REASON, USER)).rejects.toMatchObject({ statusCode: 404, code: "FLAG_NOT_FOUND" })
    expect(await waive(PROJECT, sectionEmpty.id, REASON, USER)).toMatchObject({ waived_by_user: true })
  })
})
