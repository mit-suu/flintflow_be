import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose — cùng ngữ nghĩa op-engine.test.ts (T08). */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const baselines: Doc[] = []
  let baselineSeq = 0
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
    deleteMany: async (filter: Filter) => {
      for (let i = changes.length - 1; i >= 0; i--) if (matches(changes[i], filter)) changes.splice(i, 1)
      return {}
    }
  }
  const Baseline = {
    create: async (doc: Doc) => {
      // Unique (projectId, version) như index thật
      if (baselines.some((b) => String(b.projectId) === String(doc.projectId) && b.version === doc.version)) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
      }
      const created = { _id: `bl${++baselineSeq}`, ...copy(doc) }
      baselines.push(created)
      return created
    },
    findById: async (id: string) => copy(baselines.find((b) => b._id === id) ?? null),
    deleteOne: async (filter: { _id: string }) => {
      const i = baselines.findIndex((b) => b._id === filter._id)
      if (i >= 0) baselines.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    }
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
    baselines.length = 0
    baselineSeq = 0
  }
  return { Spine, Change, Baseline, spines, changes, baselines, reset }
})

vi.mock("../../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../../spine/baseline.model.js", () => ({ Baseline: db.Baseline }))
vi.mock("../../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../../project/chat-session.model.js", () => ({
  ChatSession: {
    findById: () => {
      const p = Promise.resolve(null) as Promise<null> & { lean: () => Promise<null> }
      p.lean = async () => null
      return p
    }
  }
}))

import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import * as repo from "../../spine/spine.repository.js"
import { getSkill } from "../../../shared/ai/prompt-registry.service.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../../shared/ai/response-parser.js"
import type { DraftExecutor } from "../draft-to-ops.js"
import { PRIORITIZATION_SKILL, prioritize, scopeWarnings, unprioritized } from "./prioritization.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000005"
const USER = "650000000000000000000014"

const seed = async (mutate: (spine: Spine) => void = () => {}): Promise<Spine> => {
  const spine = structuredClone(FIXTURE)
  mutate(spine)
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
  return spine
}

/** Executor giả: trả đúng lô op được dựng sẵn, và ghi lại prompt để kiểm skill có tới model không. */
const executorFor = (ops: OpTransaction["ops"], seen: { prompt?: Record<string, unknown> } = {}): DraftExecutor =>
  (async (_actionType, input) => {
    seen.prompt = input.promptVariables as Record<string, unknown>
    const result: AiActionResult<OpTransaction> = {
      success: true,
      data: { ops, notes: "mock" },
      rawText: "{}",
      actionType: "draft" as never,
      provider: "mock",
      aiModel: "mock",
      tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1,
      logId: "prio",
      cost: 1
    }
    return result
  }) as DraftExecutor

beforeEach(() => db.reset())

describe("scopeWarnings — Won't-have không tự đổi release_scope", () => {
  it("Won't-have mà release_scope.out không nhắc tới ⇒ cảnh báo", () => {
    const spine = structuredClone(FIXTURE)
    spine.project.release_scope = { in: [], out: [] }
    spine.functions[0].priority = "wont"

    const warnings = scopeWarnings(spine)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ kind: "wont_not_in_scope_out", id: spine.functions[0].id })
  })

  it("release_scope.out có nhắc tới ⇒ không cảnh báo", () => {
    const spine = structuredClone(FIXTURE)
    spine.functions[0].priority = "wont"
    spine.project.release_scope = { in: [], out: [`Chưa làm ${spine.functions[0].name} trong bản này`] }

    expect(scopeWarnings(spine)).toEqual([])
  })

  it("không có Won't-have nào ⇒ không cảnh báo", () => {
    const spine = structuredClone(FIXTURE)
    for (const f of spine.functions) f.priority = "must"
    expect(scopeWarnings(spine)).toEqual([])
  })

  it("NFR Won't-have cũng được soi", () => {
    const spine = structuredClone(FIXTURE)
    spine.project.release_scope = { in: [], out: [] }
    for (const f of spine.functions) f.priority = "must"
    spine.nfrs[0].priority = "wont"
    expect(scopeWarnings(spine).map((w) => w.id)).toEqual([spine.nfrs[0].id])
  })
})

describe("unprioritized", () => {
  it("liệt kê đúng requirement còn priority null", () => {
    const spine = structuredClone(FIXTURE)
    for (const f of spine.functions) f.priority = "must"
    for (const n of spine.nfrs) n.priority = "should"
    spine.functions[3].priority = null
    spine.nfrs[1].priority = null

    expect(unprioritized(spine)).toEqual({ functions: [spine.functions[3].id], nfrs: [spine.nfrs[1].id] })
  })
})

describe("skill prioritization", () => {
  it("đã viết thật (không stub) và chỉ khai ghi functions/nfrs/assumptions", () => {
    const skill = getSkill(PRIORITIZATION_SKILL)
    expect(skill.stub).toBe(false)
    const roots = skill.writes.map((w) => w.split(/[.[]/)[0])
    expect([...new Set(roots)].sort()).toEqual(["assumptions", "functions", "nfrs"])
  })
})

describe("prioritize — ghi priority bằng op", () => {
  it("nội dung skill đi vào prompt; ops được áp; đếm đúng số đã xếp hạng", async () => {
    const spine = await seed((s) => {
      for (const f of s.functions) f.priority = null
      for (const n of s.nfrs) n.priority = null
    })
    const seen: { prompt?: Record<string, unknown> } = {}
    const ops = [
      { op: "set" as const, path: `functions[id=${spine.functions[0].id}].priority`, value: "must", reason: "S-9.4" },
      { op: "set" as const, path: `nfrs[id=${spine.nfrs[0].id}].priority`, value: "should", reason: "S-9.4" }
    ]

    const result = await prioritize(PROJECT, USER, { executor: executorFor(ops, seen) })

    expect(String(seen.prompt?.content_guidance)).toContain("MoSCoW")
    expect(result.prioritized).toEqual({ functions: 1, nfrs: 1 })
    expect(result.unprioritized.functions.length).toBe(spine.functions.length - 1)

    const after = (await repo.get(PROJECT))!
    expect(after.functions.find((f) => f.id === spine.functions[0].id)?.priority).toBe("must")
    expect(after.nfrs.find((n) => n.id === spine.nfrs[0].id)?.priority).toBe("should")
  })

  it("op đụng release_scope bị op-validator chặn — S-9.4 không được đổi phạm vi", async () => {
    await seed()
    const ops = [{ op: "set" as const, path: "project.release_scope", value: { in: [], out: ["mọi thứ"] } }]

    await expect(prioritize(PROJECT, USER, { executor: executorFor(ops) })).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" })
    expect((await repo.get(PROJECT))!.project.release_scope.out).not.toEqual(["mọi thứ"])
  })

  it("trả cảnh báo khi model xếp Won't mà phạm vi không nhắc tới", async () => {
    const spine = await seed((s) => {
      s.project.release_scope = { in: [], out: [] }
      for (const f of s.functions) f.priority = "must"
      for (const n of s.nfrs) n.priority = "must"
    })
    const ops = [{ op: "set" as const, path: `functions[id=${spine.functions[2].id}].priority`, value: "wont", reason: "S-9.4" }]

    const result = await prioritize(PROJECT, USER, { executor: executorFor(ops) })

    expect(result.warnings.map((w) => w.id)).toEqual([spine.functions[2].id])
    expect((await repo.get(PROJECT))!.project.release_scope.out, "phạm vi không tự đổi").toEqual([])
  })
})
