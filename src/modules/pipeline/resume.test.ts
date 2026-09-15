import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose Spine/Change — cùng ngữ nghĩa op-engine.test.ts. */
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

vi.mock("../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: db.Change }))

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine as SpineT } from "../spine/spine.types.js"
import * as repo from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import { resumeProject } from "./resume.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MINIMAL: SpineT = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-minimal.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"

const seedSpine = () => {
  const spine = structuredClone(MINIMAL)
  spine.actors = [{ id: "A00", name: "Base actor", kind: "human", description: "sẵn có từ trước" }]
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

/** Step `in_progress` giữa chừng Draft: đã ghi một op nội dung thật (add actor) nhưng chưa gate accept. */
const seedInProgressMidDraft = async (stepId: string, actorId: string): Promise<void> => {
  const record = await repo.get(PROJECT)
  const add1 = await applyTransaction(PROJECT, {
    base_version: record!.spine_version,
    ops: [{ op: "add", path: "steps[]", value: { id: stepId, status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } }],
    by: USER,
    step_id: stepId,
    reason: "seed"
  })
  const add2 = await applyTransaction(PROJECT, {
    base_version: add1.spine_version,
    ops: [{ op: "add", path: "actors[]", value: { id: actorId, name: "Mid-draft", kind: "human", description: "chưa gate" } }],
    by: USER,
    step_id: stepId,
    reason: "seed content"
  })
  const seq = add2.changes[0].seq
  await applyTransaction(PROJECT, {
    base_version: add2.spine_version,
    ops: [
      { op: "set", path: `steps[id=${stepId}].first_seq`, value: seq },
      { op: "set", path: `steps[id=${stepId}].last_seq`, value: seq }
    ],
    by: USER,
    step_id: stepId,
    reason: "seed bookkeeping"
  })
}

beforeEach(() => {
  db.reset()
})

describe("resume.service", () => {
  it("step in_progress dang dở (đóng giữa Draft) ⇒ revert dải seq, status về pending, first_seq/last_seq = null", async () => {
    seedSpine()
    await seedInProgressMidDraft("S-3.1", "A99")

    const before = await repo.get(PROJECT)
    expect(before!.actors.map((a) => a.id)).toContain("A99")
    expect(before!.steps.find((s) => s.id === "S-3.1")).toMatchObject({ status: "in_progress" })

    const result = await resumeProject(PROJECT, USER)

    expect(result.reverted_step).toBe("S-3.1")
    const after = await repo.get(PROJECT)
    expect(after!.actors.map((a) => a.id)).not.toContain("A99") // Spine về trước step (revert)
    expect(after!.actors.map((a) => a.id)).toContain("A00") // nội dung trước đó giữ nguyên
    const step = after!.steps.find((s) => s.id === "S-3.1")
    expect(step).toMatchObject({ status: "pending", first_seq: null, last_seq: null })
    expect(result.spine_version).toBe(after!.spine_version)
    expect(result.progress).toBeTruthy()
  })

  it("không có step in_progress ⇒ reverted_step null, Spine không đổi", async () => {
    seedSpine()
    const before = await repo.get(PROJECT)

    const result = await resumeProject(PROJECT, USER)

    expect(result.reverted_step).toBeNull()
    const after = await repo.get(PROJECT)
    expect(after!.spine_version).toBe(before!.spine_version)
  })

  it("step accepted không bị đụng tới (chỉ revert step in_progress)", async () => {
    seedSpine()
    const record = await repo.get(PROJECT)
    await applyTransaction(PROJECT, {
      base_version: record!.spine_version,
      ops: [{ op: "add", path: "steps[]", value: { id: "S-2.1", status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" } }],
      by: USER,
      step_id: "S-2.1",
      reason: "seed accepted step"
    })

    const result = await resumeProject(PROJECT, USER)
    expect(result.reverted_step).toBeNull()
    const after = await repo.get(PROJECT)
    expect(after!.steps.find((s) => s.id === "S-2.1")).toMatchObject({ status: "accepted" })
  })
})
