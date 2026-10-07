import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose Spine/Change/Usage — cùng ngữ nghĩa step-runner.test.ts. */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const usages: Doc[] = []
  let usageSeq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number | string | Date; $lte?: number; $in?: unknown[]; $ne?: unknown }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        if ("$ne" in e) return actual !== e.$ne
        if (e.$gte instanceof Date || typeof e.$gte === "string") return new Date(actual as string) >= new Date(e.$gte as string | Date)
        const n = Number(actual)
        return (e.$gte === undefined || n >= Number(e.$gte)) && (e.$lte === undefined || n <= e.$lte)
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
    find: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return (options?.sort?.seq === -1 ? rows.slice().reverse() : rows).map(copy)
    },
    insertMany: async (docs: Doc[]) => {
      if (docs.some((d) => changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq))) {
        throw Object.assign(new Error("E11000"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async () => ({})
  }
  const Usage = {
    insertMany: async (docs: Doc[]) => {
      const created = docs.map((d) => ({ _id: `u${++usageSeq}`, createdAt: new Date().toISOString(), ...copy(d) }))
      usages.push(...created)
      return created.map(copy)
    },
    updateMany: async (filter: Filter, update: { $set: Doc }) => {
      const matched = usages.filter((r) => matches(r, filter))
      for (const r of matched) Object.assign(r, copy(update.$set))
      return { modifiedCount: matched.length }
    },
    countDocuments: async (filter: Filter) => usages.filter((r) => matches(r, filter)).length,
    // `meter.roundCost` (gate hiện "x credit") đọc thô các dòng usage của vòng
    find: (filter: Filter) => ({ lean: async () => usages.filter((r) => matches(r, filter)).map((r) => ({ cost: r.cost })) })
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
    usages.length = 0
    usageSeq = 0
  }
  return { Spine, Change, Usage, spines, changes, usages, reset }
})

vi.mock("../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../notification/notification.service.js", () => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))
vi.mock("../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: () => Promise.resolve(null) } }))

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine as SpineT } from "../spine/spine.types.js"
import * as repo from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import { orderedSteps } from "./step-registry.js"
import type { StepRunnerDeps } from "./step-runner.service.js"
import type { AiActionInput, AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { gate, gateAssumptionIdsOf, phaseGateAssumptions, GateLimitError, REGENERATE_LIMIT, CALL_LIMIT } from "./gate.service.js"
import { acquireRun, finishRun, resetMemoryRuns } from "./run-state.service.js"
import { resumeProject } from "./resume.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { notify } from "../notification/notification.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MINIMAL: SpineT = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-minimal.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"
const STEP = "S-3.1"

const stepsBeforeS3 = () => {
  const all = orderedSteps({ screens: [], functions: [] })
  const idx = all.findIndex((s) => s.phase === "S-3")
  return all.slice(0, idx).map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seedSpine = () => {
  const spine = structuredClone(MINIMAL)
  // Một actor gốc sẵn có — revert (xoá) actor seed thêm sau không vi phạm invariant_2 (mảng rỗng).
  spine.actors = [{ id: "A00", name: "Base actor", kind: "human", description: "sẵn có từ trước" }]
  spine.progress.current_phase = "S-3"
  spine.progress.current_step = "S-3.1"
  spine.steps = stepsBeforeS3()
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

/** Đặt step `in_progress` với một change nội dung THẬT (add actor `actorId`) để regenerate revert được. */
const seedInProgressWithContent = async (stepId: string, actorId: string): Promise<number> => {
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
    ops: [{ op: "add", path: "actors[]", value: { id: actorId, name: "Seed", kind: "human", description: "x" } }],
    by: USER,
    step_id: stepId,
    reason: "seed content"
  })
  const seq = add2.changes[0].seq
  const add3 = await applyTransaction(PROJECT, {
    base_version: add2.spine_version,
    ops: [
      { op: "set", path: `steps[id=${stepId}].first_seq`, value: seq },
      { op: "set", path: `steps[id=${stepId}].last_seq`, value: seq }
    ],
    by: USER,
    step_id: stepId,
    reason: "seed bookkeeping"
  })
  return add3.spine_version
}

/** `at` mặc định = ngay bây giờ — PHẢI sau `at` thật của change `first_seq` (seed dùng applyTransaction thật). */
const seedUsage = (stepId: string, callKind: string, count: number, at = new Date(Date.now() + 1000).toISOString()) => {
  for (let i = 0; i < count; i++) {
    db.usages.push({
      _id: `pre-${stepId}-${callKind}-${i}`,
      projectId: PROJECT,
      userId: USER,
      step_id: stepId,
      call_kind: callKind,
      attempt: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost: 1,
      state: "deducted",
      expires_at: "2099-01-01T00:00:00.000Z",
      logId: null,
      createdAt: at
    })
  }
}

const draftReply = (ops: OpTransaction["ops"]): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops },
  rawText: "{}",
  actionType: "regenerate" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
  latencyMs: 1,
  logId: "regen-log",
  cost: 4
})

beforeEach(() => {
  db.reset()
  resetMemoryRuns()
  vi.mocked(notify).mockClear()
})

describe("gate.service: regenerate — trần 3/step", () => {
  it("lần 4 (regenerate_used=3) ⇒ GateLimitError REGENERATE_LIMIT, không revert/redraft", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "regenerate", 3)

    const draftExecutor = vi.fn()
    const err = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, { draftExecutor }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GateLimitError)
    expect((err as GateLimitError).code).toBe(REGENERATE_LIMIT)
    expect((err as GateLimitError).details).toEqual({ regenerate_used: 3 })
    expect(draftExecutor).not.toHaveBeenCalled()
  })

  it("dưới trần: revert dải seq cũ rồi draft lại với ops mới", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")

    const deps: Partial<StepRunnerDeps> = {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A91", name: "Regenerated", kind: "human", description: "y" } }])
    }
    const result = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, deps)

    expect(result.step.status).toBe("in_progress")
    expect(result.step.regenerate_used).toBe(1)
    const spine = await repo.get(PROJECT)
    expect(spine!.actors.map((a) => a.id)).not.toContain("A90") // bị revert
    expect(spine!.actors.map((a) => a.id)).toContain("A91") // ops mới
  })

  it("F3: regenerate 2 lần liên tiếp ⇒ lần 2 revert đúng nội dung lần 1 (không trùng phần tử)", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")

    const first = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A91", name: "R1", kind: "human", description: "x" } }])
    })
    const afterFirst = await repo.get(PROJECT)
    expect(afterFirst!.actors.map((a) => a.id)).toContain("A91")
    // Bug cũ: first_seq/last_seq không cập nhật sau redraft ⇒ vẫn null ⇒ lần 2 không revert được A91.
    expect(afterFirst!.steps.find((s) => s.id === STEP)!.first_seq).not.toBeNull()

    const second = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: first.spine_version }, {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A92", name: "R2", kind: "human", description: "y" } }])
    })
    const afterSecond = await repo.get(PROJECT)
    expect(afterSecond!.actors.map((a) => a.id)).not.toContain("A91") // A91 (lần 1) bị revert đúng, không trùng
    expect(afterSecond!.actors.map((a) => a.id)).toContain("A92")
    expect(afterSecond!.actors.map((a) => a.id)).toContain("A00") // actor gốc không đụng
    expect(second.step.regenerate_used).toBe(2)
  })

  it("FLF-260: replyLanguage do nơi gọi đọc từ phiên ⇒ lượt soạn lại mang nó", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    const inputs: AiActionInput[] = []
    await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, {
      replyLanguage: "en",
      draftExecutor: async (_type, input) => {
        inputs.push(input)
        return draftReply([{ op: "add", path: "actors[]", value: { id: "A91", name: "Regenerated", kind: "human", description: "y" } }])
      }
    })
    expect(inputs.map((i) => i.replyLanguage)).toEqual(["en"])
  })

  it("resume sau regenerate vẫn revert đúng (F3: resume dùng first_seq/last_seq đã được cập nhật)", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A91", name: "R1", kind: "human", description: "x" } }])
    })

    const result = await resumeProject(PROJECT, USER)
    expect(result.reverted_step).toBe(STEP)
    const after = await repo.get(PROJECT)
    expect(after!.actors.map((a) => a.id)).not.toContain("A91")
    expect(after!.actors.map((a) => a.id)).toContain("A00")
    expect(after!.steps.find((s) => s.id === STEP)).toMatchObject({ status: "pending", first_seq: null, last_seq: null })
  })

  it("F13: dải seq bị lẫn change không thuộc step (user sửa tay /changes) ⇒ 422 CHANGE_RANGE_INVALID, không revert âm thầm", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    const midway = await repo.get(PROJECT)

    const foreignChange = await applyTransaction(PROJECT, {
      base_version: midway!.spine_version,
      ops: [{ op: "add", path: "actors[]", value: { id: "A77", name: "User sửa tay", kind: "human", description: "ngoài step" } }],
      by: USER,
      step_id: null,
      reason: "user /changes"
    })
    await applyTransaction(PROJECT, {
      base_version: foreignChange.spine_version,
      ops: [{ op: "set", path: `steps[id=${STEP}].last_seq`, value: foreignChange.changes[0].seq }],
      by: USER,
      step_id: STEP,
      reason: "seed: mở rộng dải để chứa change ngoài step"
    })

    const before = await repo.get(PROJECT)
    const draftExecutor = vi.fn()
    const err = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: before!.spine_version }, { draftExecutor }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(422)
    expect((err as ApiError).code).toBe("CHANGE_RANGE_INVALID")
    expect(draftExecutor).not.toHaveBeenCalled()

    const after = await repo.get(PROJECT)
    expect(after!.spine_version).toBe(before!.spine_version)
    expect(after!.actors.map((a) => a.id)).toContain("A90") // không bị revert âm thầm
    expect(after!.actors.map((a) => a.id)).toContain("A77")
  })
})

describe("gate.service: B7 reopen — revision/regenerate trên step đã accepted (F6)", () => {
  it("accept rồi revision ⇒ reopen (revision_requested, reset accepted_at) rồi redraft, calls_used vòng MỚI không cộng dồn vòng cũ (F1)", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    const accepted = await gate(PROJECT, STEP, USER, { action: "accept", base_version: version })
    expect(accepted.step.status).toBe("accepted")

    // Usage của vòng CŨ (trước accept) — không được cộng vào calls_used của vòng mới sau reopen.
    seedUsage(STEP, "draft", 5, "2020-01-01T00:00:00.000Z")

    const result = await gate(
      PROJECT,
      STEP,
      USER,
      { action: "revision", note: "cần sửa mô tả actor cho rõ hơn", base_version: accepted.spine_version },
      { draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A93", name: "Reopened", kind: "human", description: "z" } }]) }
    )

    expect(result.step.status).toBe("in_progress") // redraft xong quay lại in_progress như revision thường
    expect(result.step.accepted_at).toBeNull() // B7: reset accepted_at
    expect(result.step.calls_used).toBe(1) // vòng MỚI: chỉ đếm lượt revision vừa gọi, không cộng dồn 5 usage vòng cũ

    const changes = await repo.listChanges(PROJECT)
    const reopenChange = changes.find((c) => c.path === `steps[id=${STEP}].status` && c.value === "revision_requested" && c.before === "accepted")
    expect(reopenChange).toBeTruthy() // xác nhận transition reopen thật đã xảy ra (B7 không còn chết)

    const spine = await repo.get(PROJECT)
    expect(spine!.actors.map((a) => a.id)).toContain("A93")
  })

  it("accept rồi regenerate ⇒ reopen tương tự, vòng regenerate_used tính lại từ 0", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    const accepted = await gate(PROJECT, STEP, USER, { action: "accept", base_version: version })

    const result = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: accepted.spine_version }, {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A94", name: "Regen reopen", kind: "human", description: "w" } }])
    })

    expect(result.step.regenerate_used).toBe(1)
    expect(result.step.accepted_at).toBeNull()
    const spine = await repo.get(PROJECT)
    expect(spine!.actors.map((a) => a.id)).toContain("A94")
  })

  it("accept rồi accept lại (action=accept) ⇒ vẫn STEP_NOT_RUNNABLE — chỉ revision/regenerate được reopen", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    const accepted = await gate(PROJECT, STEP, USER, { action: "accept", base_version: version })

    const err = await gate(PROJECT, STEP, USER, { action: "accept", base_version: accepted.spine_version }).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: "STEP_NOT_RUNNABLE" })
  })
})

describe("gate.service: accept_as_is — id cờ mới (F14)", () => {
  it("hậu tố số LỚN NHẤT hiện có + 1 — tránh trùng id khi mảng có khoảng trống (cờ giữa đã bị cascade xoá)", async () => {
    seedSpine()
    const flagBase = { level: "yellow" as const, rule_id: "x", section_id: "fixed:I", target_id: null, remediation_step: "S-3.1", opened_at_version: 1, resolved_at: null, waived_by_user: false, waive_reason: null, waived_at_version: null }
    db.spines[0].flags = [
      { ...flagBase, id: "FL001", message: "a" },
      { ...flagBase, id: "FL003", message: "b" } // FL002 coi như đã bị cascade xoá — còn khoảng trống
    ]
    const version = await seedInProgressWithContent(STEP, "A90")

    const result = await gate(PROJECT, STEP, USER, { action: "accept_as_is", note: "chấp nhận hiện trạng do thời gian dự án", base_version: version })
    expect(result.step.status).toBe("accepted")

    const spine = await repo.get(PROJECT)
    const newFlag = spine!.flags.find((f) => f.rule_id === "accepted_as_is")
    // `flags.length + 1` (cách cũ) = 3 ⇒ trùng FL003 đã có. Đúng phải là FL004 (hậu tố lớn nhất + 1).
    expect(newFlag?.id).toBe("FL004")
  })
})

describe("gate.service: CALL_LIMIT — trần 8/step chặn regenerate/revision, không chặn accept", () => {
  it("calls_used = 8 ⇒ regenerate/revision trả CALL_LIMIT", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "draft", 8)

    const draftExecutor = vi.fn()
    const err = await gate(PROJECT, STEP, USER, { action: "revision", note: "cần sửa lại phần actor cho rõ hơn", base_version: version }, { draftExecutor }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GateLimitError)
    expect((err as GateLimitError).code).toBe(CALL_LIMIT)
    expect(draftExecutor).not.toHaveBeenCalled()
  })

  it("calls_used = 8 vẫn cho accept", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "draft", 8)

    const result = await gate(PROJECT, STEP, USER, { action: "accept", base_version: version })
    expect(result.step.status).toBe("accepted")
  })
})

describe("gate.service: accept_as_is", () => {
  it("ghi cờ vàng accepted_as_is với note, step accepted", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "regenerate", 3)

    const note = "Chấp nhận hiện trạng — actor phụ sẽ bổ sung ở vòng sau theo yêu cầu khách hàng"
    const result = await gate(PROJECT, STEP, USER, { action: "accept_as_is", note, base_version: version })

    expect(result.step.status).toBe("accepted")
    expect(result.step.accepted_at).not.toBeNull()
    const spine = await repo.get(PROJECT)
    const flag = spine!.flags.find((f) => f.rule_id === "accepted_as_is")
    expect(flag).toMatchObject({ level: "yellow", message: note, remediation_step: STEP, waived_by_user: false })
  })
})

describe("gate.service: accept", () => {
  it("step không in_progress/revision_requested ⇒ STEP_NOT_RUNNABLE", async () => {
    seedSpine()
    const record = await repo.get(PROJECT)
    const err = await gate(PROJECT, STEP, USER, { action: "accept", base_version: record!.spine_version }).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: "STEP_NOT_RUNNABLE" })
  })

  it("F19: accept step cuối cùng của phase S-2 ⇒ notify phase_accepted với đúng userId + meta.phase", async () => {
    // Mọi step trước S-3 accepted, TRỪ S-2.5 (đặt in_progress ở dưới) — accept S-2.5 xong ⇒ cả phase S-2 accepted.
    const spine = structuredClone(MINIMAL)
    spine.progress.current_phase = "S-2"
    spine.progress.current_step = "S-2.5"
    spine.steps = stepsBeforeS3().filter((s) => s.id !== "S-2.5")
    db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }

    const version = await seedInProgressWithContent("S-2.5", "A90")
    const result = await gate(PROJECT, "S-2.5", USER, { action: "accept", base_version: version })
    expect(result.step.status).toBe("accepted")

    expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "phase_accepted", meta: { phase: "S-2" } }))
  })
})

describe("gate.service: revision sửa giả định (FLF-232)", () => {
  const seedB03 = (): number => {
    seedSpine()
    const spine = db.spines[0] as Record<string, unknown> & { project: Record<string, unknown>; spine_version: number }
    spine.progress = { ...(spine.progress as Record<string, unknown>), current_phase: "B-0", current_step: "B-0.3" }
    spine.steps = [
      { id: "B-0.1", status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" },
      { id: "B-0.2", status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" },
      { id: "B-0.3", status: "in_progress", first_seq: null, last_seq: null, accepted_at: null }
    ]
    spine.project = { ...spine.project, form_factor: ["web_app"], stakes: "production" }
    spine.assumptions = [
      {
        id: "AS01",
        path: "project.form_factor",
        statement: "The product is a web app.",
        statement_vi: "Sản phẩm là ứng dụng web.",
        rationale: "Staff use desktops.",
        origin_step_id: "B-0.1",
        status: "unconfirmed",
        confirmed_at: null
      }
    ]
    return spine.spine_version
  }
  const revisedOps: OpTransaction["ops"] = [
    { op: "set", path: "project.form_factor", value: "mobile_app" },
    { op: "set", path: "assumptions[id=AS01].statement", value: "The product is a mobile app." },
    { op: "set", path: "assumptions[id=AS01].statement_vi", value: "Sản phẩm là ứng dụng điện thoại." },
    { op: "set", path: "assumptions[id=AS01].status", value: "confirmed" }
  ]
  const withNotes = (ops: OpTransaction["ops"], notes?: string): AiActionResult<OpTransaction> => {
    const reply = draftReply(ops)
    return notes ? { ...reply, data: { ops, notes } } : reply
  }

  /**
   * Dựng lượt chạy đang đứng ở cổng với đúng những điều tin cổng NÓI RA. Quyền đổi `status` của lượt revision lấy từ
   * đây, nên test phải khai cổng đã nói gì; run-state rỗng nghĩa là cổng chưa nói điều nào và không điều nào chốt được.
   */
  const gateSaid = async (stepId: string, ids: readonly string[]): Promise<void> => {
    const run = await acquireRun(PROJECT, stepId)
    await finishRun(PROJECT, stepId, run.run_id, "gate", { gate_payload: { new_assumptions: ids.map((id) => ({ id, text: id })) } })
  }

  it("lời sửa đổi trường thật + câu giả định + status confirmed trong một lượt, và trả lời AI xác nhận (message_vi)", async () => {
    const version = seedB03()
    await gateSaid("B-0.3", ["AS01"])
    const result = await gate(
      PROJECT,
      "B-0.3",
      USER,
      { action: "revision", note: "bệnh nhân dùng app điện thoại", base_version: version },
      { draftExecutor: async () => withNotes(revisedOps, "Được rồi, tôi chuyển sang ứng dụng điện thoại cho bệnh nhân. Bạn xem lại giúp nhé.") }
    )

    expect(result.message_vi).toBe("Được rồi, tôi chuyển sang ứng dụng điện thoại cho bệnh nhân. Bạn xem lại giúp nhé.")
    const spine = await repo.get(PROJECT)
    expect(spine!.project.form_factor).toEqual(["mobile_app"])
    const assumption = spine!.assumptions.find((a) => a.id === "AS01")!
    expect(assumption).toMatchObject({ statement: "The product is a mobile app.", statement_vi: "Sản phẩm là ứng dụng điện thoại.", status: "confirmed" })
    // confirmed_at do server đặt, không lấy từ model
    expect(assumption.confirmed_at).toEqual(expect.any(String))
  })

  it("lời sửa bỏ giả định ⇒ status rejected, không cần ghi trường thật", async () => {
    const version = seedB03()
    await gateSaid("B-0.3", ["AS01"])
    await gate(
      PROJECT,
      "B-0.3",
      USER,
      { action: "revision", note: "khỏi cần giả định đó", base_version: version },
      { draftExecutor: async () => withNotes([{ op: "set", path: "assumptions[id=AS01].status", value: "rejected" }]) }
    )
    const spine = await repo.get(PROJECT)
    expect(spine!.assumptions[0].status).toBe("rejected")
    expect(spine!.project.form_factor).toEqual(["web_app"])
  })

  it("đổi câu giả định mà không ghi đúng trường thật của nó ⇒ bị từ chối, Spine nguyên trạng", async () => {
    const version = seedB03()
    const wrongPath: OpTransaction["ops"] = [
      { op: "set", path: "project.stakes", value: "regulated" },
      revisedOps[1],
      revisedOps[3]
    ]
    const err = await gate(
      PROJECT,
      "B-0.3",
      USER,
      { action: "revision", note: "bệnh nhân dùng app điện thoại", base_version: version },
      { draftExecutor: async () => withNotes(wrongPath) }
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(JSON.stringify((err as { errors?: unknown }).errors)).toContain("assumption_path_mismatch")
    const spine = await repo.get(PROJECT)
    expect(spine!.project.stakes).toBe("production")
    expect(spine!.assumptions[0].status).toBe("unconfirmed")
  })

  const seedB14 = (): number => {
    seedSpine()
    const spine = db.spines[0] as Record<string, unknown> & { project: Record<string, unknown>; spine_version: number }
    spine.progress = { ...(spine.progress as Record<string, unknown>), current_phase: "B-1", current_step: "B-1.4" }
    const done = ["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3"].map((id) => ({ id, status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
    spine.steps = [...done, { id: "B-1.4", status: "in_progress", first_seq: null, last_seq: null, accepted_at: null }]
    spine.project = { ...spine.project, form_factor: ["web_app"] }
    const base = { rationale: "r", status: "unconfirmed", confirmed_at: null }
    spine.assumptions = [
      { ...base, id: "AS10", path: "project.form_factor", statement: "The product is a web app.", statement_vi: "Sản phẩm là ứng dụng web.", origin_step_id: "B-1.4" },
      { ...base, id: "AS11", path: "project.stakes", statement: "Stakes are production.", statement_vi: "Mức độ là vận hành thật.", origin_step_id: "B-1.2" }
    ]
    return spine.spine_version
  }

  it("giả định của chính bước ở cổng: ghi được path thật dù ngoài writes của bước (B-1.4 chỉ ghi addendum/assumptions)", async () => {
    const version = seedB14()
    await gateSaid("B-1.4", ["AS10"])
    const ops: OpTransaction["ops"] = [
      { op: "set", path: "project.form_factor", value: "mobile_app" },
      { op: "set", path: "assumptions[id=AS10].statement", value: "The product is a mobile app." },
      { op: "set", path: "assumptions[id=AS10].statement_vi", value: "Sản phẩm là ứng dụng di động." },
      { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }
    ]
    const result = await gate(PROJECT, "B-1.4", USER, { action: "revision", note: "không, là xếp hàng phòng khám", base_version: version }, { draftExecutor: async () => withNotes(ops) })

    const spine = await repo.get(PROJECT)
    expect(spine!.project.form_factor).toEqual(["mobile_app"])
    expect(spine!.assumptions.find((a) => a.id === "AS10")).toMatchObject({ status: "confirmed" })
    // Không có notes ⇒ vẫn có lời xác nhận dựng từ tóm tắt thay đổi
    expect(result.message_vi).toEqual(expect.any(String))
    expect(result.message_vi).not.toBe("")
  })

  it("cổng cuối B-1 (B-1.6): sửa addendum do B-1.2 ghi + giả định của B-1.2 được áp, không lỗi phạm vi ghi", async () => {
    const version = seedB14()
    const spine = db.spines[0] as Record<string, unknown> & { steps: { id: string; status: string }[]; progress: Record<string, unknown>; assumptions: { id: string; path: string }[]; addendum: unknown[] }
    spine.steps = ["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5"]
      .map((id) => ({ id, status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
      .concat([{ id: "B-1.6", status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } as never])
    spine.progress = { ...spine.progress, current_step: "B-1.6" }
    spine.addendum = [{ id: "AD2", topic: "Users", content: "Lễ tân nhận lịch qua điện thoại.", content_en: "Receptionists take bookings by phone.", target_section: "fixed:2.1", captured_at: "2026-01-01T00:00:00.000Z" }]
    spine.assumptions[1].path = "addendum[id=AD2].content"
    await gateSaid("B-1.6", ["AS11"])
    const ops: OpTransaction["ops"] = [
      { op: "set", path: "addendum[id=AD2].content", value: "Lễ tân xác nhận lịch qua Zalo." },
      { op: "set", path: "addendum[id=AD2].content_en", value: "Receptionists confirm bookings via Zalo." },
      { op: "set", path: "assumptions[id=AS11].statement", value: "Receptionists confirm bookings via Zalo." },
      { op: "set", path: "assumptions[id=AS11].statement_vi", value: "Lễ tân xác nhận lịch qua Zalo." },
      { op: "set", path: "assumptions[id=AS11].status", value: "confirmed" }
    ]
    await gate(PROJECT, "B-1.6", USER, { action: "revision", note: "lễ tân dùng Zalo chứ không gọi điện", base_version: version }, { draftExecutor: async () => withNotes(ops) })

    const after = await repo.get(PROJECT)
    expect(after!.addendum.find((a) => a.id === "AD2")!.content).toBe("Lễ tân xác nhận lịch qua Zalo.")
    expect(after!.assumptions.find((a) => a.id === "AS11")).toMatchObject({ status: "confirmed", statement_vi: "Lễ tân xác nhận lịch qua Zalo." })
  })

  it("giả định cũ có path project.vision ở Brief: sửa qua addendum vision (content + content_en) tính là ghi trường thật", async () => {
    const version = seedB14()
    const spine = db.spines[0] as Record<string, unknown> & { assumptions: { id: string; path: string }[] }
    spine.addendum = [{ id: "AD1", topic: "vision", content: "Công cụ đặt lịch.", content_en: "A booking tool.", target_section: "fixed:1", captured_at: "2026-01-01T00:00:00.000Z" }]
    spine.assumptions[0].path = "project.vision"
    await gateSaid("B-1.4", ["AS10"])
    const ops: OpTransaction["ops"] = [
      { op: "set", path: "addendum[id=AD1].content", value: "Công cụ xếp hàng cho phòng khám." },
      { op: "set", path: "addendum[id=AD1].content_en", value: "A clinic queue tool." },
      { op: "set", path: "assumptions[id=AS10].statement", value: "The vision is a clinic queue tool." },
      { op: "set", path: "assumptions[id=AS10].statement_vi", value: "Tầm nhìn là công cụ xếp hàng cho phòng khám." },
      { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }
    ]
    await gate(PROJECT, "B-1.4", USER, { action: "revision", note: "không, là xếp hàng phòng khám", base_version: version }, { draftExecutor: async () => withNotes(ops) })

    const after = await repo.get(PROJECT)
    expect(after!.addendum[0].content_en).toBe("A clinic queue tool.")
    expect(after!.assumptions.find((a) => a.id === "AS10")).toMatchObject({ status: "confirmed" })
    expect(after!.project.vision).not.toBe("A clinic queue tool.")
  })

  it("viết lại câu giả định project.vision mà không sửa addendum vision ⇒ assumption_path_mismatch", async () => {
    const version = seedB14()
    const spine = db.spines[0] as Record<string, unknown> & { assumptions: { id: string; path: string }[] }
    spine.addendum = [{ id: "AD1", topic: "vision", content: "Công cụ đặt lịch.", content_en: "A booking tool.", target_section: "fixed:1", captured_at: "2026-01-01T00:00:00.000Z" }]
    spine.assumptions[0].path = "project.vision"
    const err = await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "đổi", base_version: version },
      {
        draftExecutor: async () =>
          withNotes([
            { op: "set", path: "assumptions[id=AS10].statement", value: "The vision is a clinic queue tool." },
            { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }
          ])
      }
    ).catch((e: unknown) => e)
    expect(JSON.stringify((err as { errors?: unknown }).errors)).toContain("assumption_path_mismatch")
  })

  it("path ngoài writes mà KHÔNG thuộc giả định của cổng vẫn bị chặn (path_not_writable)", async () => {
    const version = seedB14()
    const err = await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "đổi mức độ", base_version: version },
      { draftExecutor: async () => withNotes([{ op: "set", path: "project.stakes", value: "regulated" }]) }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(JSON.stringify((err as { errors?: unknown }).errors)).toContain("path_not_writable")
  })

  it("chỉ đổi status của giả định cổng vừa nói: giả định của bước khác (AS11, B-1.2) giữ nguyên, lượt sửa không hỏng", async () => {
    const version = seedB14()
    await gateSaid("B-1.4", ["AS10"])
    await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "ok hết", base_version: version },
      { draftExecutor: async () => withNotes([{ op: "set", path: "assumptions[id=AS11].status", value: "confirmed" }]) }
    )
    expect((await repo.get(PROJECT))!.assumptions.find((a) => a.id === "AS11")!.status).toBe("unconfirmed")
  })

  it("cổng cuối giai đoạn: giả định thuộc cổng mà tin KHÔNG nói ra vẫn ở unconfirmed, điều tin nói ra thì chốt được", async () => {
    const version = seedB14()
    const spine = db.spines[0] as Record<string, unknown> & { steps: unknown[]; progress: Record<string, unknown> }
    spine.steps = ["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5"]
      .map((id) => ({ id, status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
      .concat([{ id: "B-1.6", status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } as never])
    spine.progress = { ...spine.progress, current_step: "B-1.6" }
    // Cổng B-1.6 sở hữu cả AS10 và AS11, nhưng tin chỉ nói AS10
    await gateSaid("B-1.6", ["AS10"])

    await gate(
      PROJECT,
      "B-1.6",
      USER,
      { action: "revision", note: "đúng cả hai", base_version: version },
      {
        draftExecutor: async () =>
          withNotes([
            { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" },
            { op: "set", path: "assumptions[id=AS11].status", value: "confirmed" }
          ])
      }
    )

    const after = await repo.get(PROJECT)
    expect(after!.assumptions.find((a) => a.id === "AS10")!.status).toBe("confirmed")
    expect(after!.assumptions.find((a) => a.id === "AS11")!.status).toBe("unconfirmed")
  })

  it("quyền sửa rộng hơn quyền chốt: giả định tin không nói vẫn sửa được câu + path thật, chỉ status giữ nguyên", async () => {
    const version = seedB14()
    await gateSaid("B-1.4", [])

    await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "không, là app điện thoại", base_version: version },
      {
        draftExecutor: async () =>
          withNotes([
            { op: "set", path: "project.form_factor", value: "mobile_app" },
            { op: "set", path: "assumptions[id=AS10].statement", value: "The product is a mobile app." },
            { op: "set", path: "assumptions[id=AS10].statement_vi", value: "Sản phẩm là ứng dụng điện thoại." },
            { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }
          ])
      }
    )

    const after = await repo.get(PROJECT)
    // project.form_factor ngoài writes của B-1.4 — vẫn ghi được vì AS10 là giả định còn mở của cổng
    expect(after!.project.form_factor).toEqual(["mobile_app"])
    expect(after!.assumptions.find((a) => a.id === "AS10")).toMatchObject({
      statement: "The product is a mobile app.",
      status: "unconfirmed",
      confirmed_at: null
    })
  })

  it("mở lại bước đã accepted (B7): không còn tin cổng nào trong run-state ⇒ không giả định nào chốt được", async () => {
    const version = seedB14()
    await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "sửa lại giúp", base_version: version },
      { draftExecutor: async () => withNotes([{ op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }]) }
    )
    expect((await repo.get(PROJECT))!.assumptions.find((a) => a.id === "AS10")!.status).toBe("unconfirmed")
  })

  it("revision chỉ đổi giả định (không có notes, không có nội dung khác) vẫn trả message_vi", async () => {
    const version = seedB14()
    const result = await gate(
      PROJECT,
      "B-1.4",
      USER,
      { action: "revision", note: "đúng rồi", base_version: version },
      { draftExecutor: async () => withNotes([{ op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }]) }
    )
    expect(result.message_vi).toBe("Tôi đã cập nhật lại theo ý bạn.")
  })

  it("FLF-260: revision với replyLanguage en ⇒ lượt soạn lại mang en, lời xác nhận dự phòng bằng tiếng Anh", async () => {
    const version = seedB14()
    const inputs: AiActionInput[] = []
    const result = await gate(
      PROJECT,
      "B-1.4",
      USER,
      // Ghi chú cổng viết tiếng Việt không đổi ngôn ngữ: gate không đoán, chỉ theo ngôn ngữ nơi gọi đưa vào
      { action: "revision", note: "đúng rồi", base_version: version },
      {
        replyLanguage: "en",
        draftExecutor: async (_type, input) => {
          inputs.push(input)
          return withNotes([{ op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }])
        }
      }
    )
    expect(inputs.map((i) => i.replyLanguage)).toEqual(["en"])
    expect(result.message_vi).toBe("I've updated it as you asked.")
  })

  it("FLF-260: revision không có notes ⇒ lời xác nhận dựng từ tóm tắt bằng ngôn ngữ của phiên", async () => {
    const version = seedB14()
    await gateSaid("B-1.4", ["AS10"])
    const ops: OpTransaction["ops"] = [
      { op: "set", path: "project.form_factor", value: "mobile_app" },
      { op: "set", path: "assumptions[id=AS10].statement", value: "The product is a mobile app." },
      { op: "set", path: "assumptions[id=AS10].statement_vi", value: "The product is a mobile app." },
      { op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }
    ]
    const result = await gate(PROJECT, "B-1.4", USER, { action: "revision", note: "it's a phone app", base_version: version }, { replyLanguage: "en", draftExecutor: async () => withNotes(ops) })
    expect(result.message_vi).toBe("I've updated the system overview. Have a look, and if it all looks right we'll move on.")
  })

  it("FLF-260: nơi gọi không đưa ngôn ngữ ⇒ lượt soạn lại không mang field (prompt như cũ)", async () => {
    const version = seedB14()
    const inputs: AiActionInput[] = []
    await gate(PROJECT, "B-1.4", USER, { action: "revision", note: "đúng rồi", base_version: version }, {
      draftExecutor: async (_type, input) => {
        inputs.push(input)
        return withNotes([{ op: "set", path: "assumptions[id=AS10].status", value: "confirmed" }])
      }
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).not.toHaveProperty("replyLanguage")
  })

  it("gateAssumptionIdsOf: bước thường = giả định chưa xác nhận do chính nó sinh; bước cuối giai đoạn = cả giai đoạn", async () => {
    seedB14()
    const spine = (await repo.get(PROJECT))!
    expect([...gateAssumptionIdsOf(spine, "B-1.4")]).toEqual(["AS10"])
    expect([...gateAssumptionIdsOf(spine, "B-1.2")]).toEqual(["AS11"])
    expect([...gateAssumptionIdsOf(spine, "B-1.6")].sort()).toEqual(["AS10", "AS11"])
  })

  it("phaseGateAssumptions: cổng cuối giai đoạn lấy MỌI giả định chưa xác nhận của giai đoạn từ Spine (kể cả bước im chạy ở lượt trước)", async () => {
    seedB14()
    const spine = (await repo.get(PROJECT))!
    // AS10 do bước cuối sinh, AS11 do B-1.2 sinh ở lượt trước — tập trả về là ĐẦY ĐỦ, việc cắt theo lời đã nói là của cổng
    expect(phaseGateAssumptions(spine, "B-1.6").map((a) => a.id).sort()).toEqual(["AS10", "AS11"])
    expect(phaseGateAssumptions(spine, "B-1.6").find((a) => a.id === "AS11")?.text_vi).toBe("Mức độ là vận hành thật.")
    spine.assumptions.find((a) => a.id === "AS11")!.status = "confirmed"
    expect(phaseGateAssumptions(spine, "B-1.6").map((a) => a.id)).toEqual(["AS10"])
  })

  it("accept/regenerate không có message_vi (tương thích FE cũ)", async () => {
    const version = seedB03()
    const accepted = await gate(PROJECT, "B-0.3", USER, { action: "accept", base_version: version })
    expect(accepted.message_vi).toBeUndefined()
  })
})
