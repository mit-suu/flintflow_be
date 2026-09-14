import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"

vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))
vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn(), applyAndSave: vi.fn(), saveWithVersion: vi.fn() }
})

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { applyAndSave, get, saveWithVersion } from "../spine/spine.repository.js"
import { planTransaction } from "../spine/op-engine.js"
import { AiActionError, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { projectStep, type StepContext } from "./context-projection.js"
import { DraftRejectedError, draftOps, type DraftExecutor } from "./draft-to-ops.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, "../../../fixtures")
const readJson = (...s: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...s), "utf8"))
const FIXTURE: Spine = spineSchema.parse(readJson("spine-fixture-19-screens.json"))

interface OpCase {
  name: string
  step_id: string
  spine_before_overrides?: Record<string, unknown>
  expected_ops: OpTransaction["ops"]
  must_reject?: string
}

const baseOf = (c: OpCase): Spine => {
  const spine = structuredClone(FIXTURE)
  for (const [dotted, value] of Object.entries(c.spine_before_overrides ?? {})) {
    const keys = dotted.split(".")
    let node = spine as unknown as Record<string, unknown>
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
    node[keys[keys.length - 1]] = value
  }
  return spine
}

const ctxFor = (spine: Spine, stepId: string): StepContext => ({
  ...projectStep(spine, stepId),
  documents: "",
  documentTokens: 0,
  transcriptTail: "User: answer",
  contextTokens: 123
})

const reply = (ops: unknown[], extra: Partial<OpTransaction> = {}): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops: ops as OpTransaction["ops"], ...extra },
  rawText: "{}",
  actionType: "draft" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
  latencyMs: 1,
  logId: "log-1",
  cost: 2
})

describe("draftOps × 10 ca op T02 (mock provider trả expected_ops)", () => {
  for (let i = 1; i <= 10; i++) {
    const file = `case-${String(i).padStart(2, "0")}.json`
    const opCase = readJson("op-cases", file) as OpCase

    it(`${file} — ${opCase.name}`, async () => {
      const spine = baseOf(opCase)
      // Fixture T02 ghi id template (`S-5.1`); step registry đòi id vòng đầy đủ `S-5.1@<màn>`
      const stepId = opCase.step_id.startsWith("S-5.") && !opCase.step_id.includes("@") ? `${opCase.step_id}@${spine.progress.screen_cursor ?? "nonscreen"}` : opCase.step_id
      const executor = vi.fn<DraftExecutor>(async () => reply(opCase.expected_ops))
      const run = draftOps("p", stepId, ctxFor(spine, stepId), { userId: "u", spine, executor })

      if (opCase.must_reject) {
        const err = await run.then(
          () => null,
          (e: unknown) => e
        )
        expect(err).toBeInstanceOf(DraftRejectedError)
        const rejected = err as DraftRejectedError
        expect(rejected).toMatchObject({ statusCode: 422, code: "NEEDS_USER_INPUT" })
        expect(rejected.errors.map((e) => e.rule)).toContain(opCase.must_reject)
        expect(executor).toHaveBeenCalledTimes(3)
        return
      }

      const result = await run
      expect(result.attempts).toHaveLength(1)
      expect(result.txn).toMatchObject({ base_version: spine.spine_version, step_id: stepId, by: "u" })
      expect(() => planTransaction(spine, result.txn!, { startSeq: 1 })).not.toThrow()
      expect(result.usage).toEqual([{ attempt: 1, call_kind: "draft", tokens_in: 1000, tokens_out: 200, cost: 2, logId: "log-1" }])
    })
  }
})

describe("draftOps retry", () => {
  const spine = structuredClone(FIXTURE)
  const ctx = ctxFor(spine, "S-3.1")

  it("lần 1 sai path, lần 2 đúng ⇒ trả txn; lỗi lần 1 được gửi lại cho model", async () => {
    const executor = vi
      .fn<DraftExecutor>()
      .mockResolvedValueOnce(reply([{ op: "set", path: "actors[id=A99].name", value: "Ghost" }]))
      .mockResolvedValueOnce(reply([{ op: "set", path: "actors[id=A01].name", value: "Owner" }], { notes: "renamed" }))

    const result = await draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor })
    expect(result.attempts.map((a) => a.errors.length)).toEqual([1, 0])
    expect(result.notes).toBe("renamed")
    expect(result.usage).toHaveLength(2)

    const secondVars = executor.mock.calls[1][1].promptVariables as Record<string, unknown>
    expect(secondVars.validation_errors).toMatchObject([{ rule: "path_not_resolved" }])
    expect(secondVars.previous_ops).toEqual([{ op: "set", path: "actors[id=A99].name", value: "Ghost" }])
    const firstVars = executor.mock.calls[0][1].promptVariables as Record<string, unknown>
    expect(firstVars).toMatchObject({ step_id: "S-3.1", call_kind: "draft", validation_errors: "(none)", previous_ops: "(none)", answers: "User: answer" })
    expect(executor.mock.calls[0][0]).toBe("draft")
  })

  it("txn id luôn do server sinh (bỏ txn model trả); ops rỗng ⇒ txn null kèm notes", async () => {
    const withTxn = vi.fn<DraftExecutor>().mockResolvedValue(reply([{ op: "set", path: "actors[id=A01].name", value: "Owner" }], { txn: "model-txn" }))
    const a = await draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor: withTxn })
    const b = await draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor: withTxn })
    expect(a.txn?.txn).not.toBe("model-txn")
    expect(a.txn?.txn).not.toBe(b.txn?.txn)

    const empty = vi.fn<DraftExecutor>().mockResolvedValue(reply([], { notes: "Nothing to change" }))
    const none = await draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor: empty })
    expect(none).toMatchObject({ txn: null, notes: "Nothing to change" })
  })

  it("ghi ngoài quyền của step bị từ chối; parse lỗi được retry; hết 3 lượt ⇒ 422, không ghi Spine", async () => {
    const executor = vi
      .fn<DraftExecutor>()
      .mockRejectedValueOnce(new AiActionError(422, "not json", "PARSE_FAILED"))
      .mockResolvedValueOnce(reply([{ op: "set", path: "nfrs[id=N05].metric", value: "x" }]))
      .mockResolvedValueOnce(reply([{ op: "set", path: "actors[id=A01].id", value: "A77" }]))

    const err = await draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor, callKind: "regenerate" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DraftRejectedError)
    const rejected = err as DraftRejectedError
    expect(rejected.attempts.map((a) => a.errors[0]?.rule)).toEqual(["schema_invalid", "path_not_writable", "key_change_forbidden"])
    expect(rejected.lastOps).toEqual([{ op: "set", path: "actors[id=A01].id", value: "A77" }])
    expect(executor.mock.calls.every((c) => c[0] === "regenerate")).toBe(true)
    expect(applyAndSave).not.toHaveBeenCalled()
    expect(saveWithVersion).not.toHaveBeenCalled()
  })

  it("lỗi không phải schema (hết credit) ném thẳng, không retry", async () => {
    const executor = vi.fn<DraftExecutor>().mockRejectedValue(new AiActionError(402, "no credit", "INSUFFICIENT_CREDIT"))
    await expect(draftOps("p", "S-3.1", ctx, { userId: "u", spine, executor })).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it("không truyền spine ⇒ đọc repository và chặn khi version lệch ctx", async () => {
    vi.mocked(get).mockResolvedValue({ projectId: "p", ...structuredClone(FIXTURE), spine_version: 5 })
    const executor = vi.fn<DraftExecutor>()
    await expect(draftOps("p", "S-3.1", ctx, { userId: "u", executor })).rejects.toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
    expect(executor).not.toHaveBeenCalled()
  })
})
