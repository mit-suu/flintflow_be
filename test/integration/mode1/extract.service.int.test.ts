/**
 * I-4 trích field (nút 1.8) ở tầng service trên Mongo thật + provider AI giả — plan §8.2 `extract.service.test.ts`.
 * FLF-172 P4. Gọi `runExtraction` trực tiếp (không qua job nền) để kiểm từng lượt gọi AI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

/** Section trong prompt I-4 của mỗi lượt gọi provider (kể cả lượt retry). */
let calls: string[] = []
const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
const record = (fn: (prompt: string) => string | Error | undefined) => (prompt: string) => {
  if (prompt.includes("# Import Extract")) calls.push(sectionOf(prompt))
  return fn(prompt)
}

beforeEach(() => {
  resetMockLlm()
  calls = []
  mockOverrides.next = record(fakeMode1)
})

const TABLE_SECTIONS = ["fixed:2.1", "fixed:2.2.2", "fixed:5.1"]
/** Thứ tự section có chữ (gọi AI) của SRS mẫu. */
const AI_ORDER = ["fixed:1", "fixed:2.2.1", "fixed:3.1.2"]

const wallet = async (userId: string) => CreditWallet.findOne({ userId }).lean()
const draftsOf = async (importId: string) => ExtractionDraft.find({ import_id: importId }).lean()

describe("I-4 — bảng khớp đủ cột", () => {
  it("bảng actor/UC/BR trích tất định, không gọi AI, không usage, không trừ credit", async () => {
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("fields_review")

    for (const s of TABLE_SECTIONS) expect(calls, s).not.toContain(s)
    expect(calls).toHaveLength(6)
    const drafts = await draftsOf(ctx.importId)
    for (const s of TABLE_SECTIONS) {
      const d = drafts.find((x) => x.section_id === s)!
      expect(d, s).toMatchObject({ status: "done", usage_id: null })
      expect(d.fields.length, s).toBeGreaterThan(0)
      expect(d.fields.every((f) => f.origin === "deterministic"), s).toBe(true)
    }
    const uc = drafts.find((x) => x.section_id === "fixed:2.2.2")!
    expect(uc.fields.map((f) => [f.path, f.value])).toEqual(
      expect.arrayContaining([
        ["use_cases[id=UC-01].name", "Register account"],
        ["use_cases[id=UC-02].actor_ids", ["Learner"]]
      ])
    )
    expect(await Usage.countDocuments({ projectId: ctx.projectId, step_id: { $in: TABLE_SECTIONS.map((s) => `I-4:${s}`) } })).toBe(0)
    // 6 lượt × 2 credit
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 988, reserved: 0 })
  })
})

describe("I-4 — output sai schema", () => {
  it("sai schema 2 lần rồi đúng ⇒ retry trong cùng lượt (3 lần gọi), trừ credit một lần", async () => {
    let bad = 0
    mockOverrides.next = record((prompt) => {
      if (prompt.includes("# Import Extract") && sectionOf(prompt) === "fixed:1" && bad < 2) {
        bad++
        return bad === 1 ? "not json at all" : JSON.stringify({ section_id: "fixed:1", items: [{ entity: "flags", key: null, value: {}, confidence: 2, source_block_ids: [] }] })
      }
      return fakeMode1(prompt)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.paused).toBeNull()
    expect(calls.filter((s) => s === "fixed:1")).toHaveLength(3)
    expect(calls).toHaveLength(8)
    expect(await Usage.find({ projectId: ctx.projectId, step_id: "I-4:fixed:1" }).distinct("state")).toEqual(["deducted"])
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 988, reserved: 0 })
    const d = (await draftsOf(ctx.importId)).find((x) => x.section_id === "fixed:1")!
    expect(d.status).toBe("done")
  }, 20_000)

  it("sai schema cả 3 lần (retry ≤ 2) ⇒ dừng resume_later, section failed, hoàn credit", async () => {
    mockOverrides.next = record((prompt) => (prompt.includes("# Import Extract") ? '{"section_id":"fixed:1","items":"nope"}' : fakeMode1(prompt)))
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls).toEqual(["fixed:1", "fixed:1", "fixed:1"])
    expect(run.doc.status).toBe("extracting")
    expect(run.doc.paused?.reason).toBe("resume_later")
    expect(run.doc.extract_cursor).toBe("fixed:1")
    expect(run.sections.find((s) => s.section_id === "fixed:1")).toMatchObject({ status: "failed" })
    expect(run.sections.find((s) => s.section_id === "fixed:1")?.error).toBeTruthy()
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 1000, reserved: 0 })
    expect(await Usage.find({ projectId: ctx.projectId, step_id: "I-4:fixed:1" }).distinct("state")).toEqual(["refunded"])
  }, 20_000)
})

describe("I-4 — độ tin", () => {
  it("field độ tin < 0.7 ⇒ fields_review, chỉ field đó cần xác nhận", async () => {
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("fields_review")
    const needing = run.sections.filter((s) => s.fields_needing_review > 0)
    expect(needing.map((s) => s.fields_needing_review)).toEqual([1, 1])
    expect(needing.every((s) => s.section_id.startsWith("function:@B"))).toBe(true)
  })

  it("mọi field ≥ 0.7 ⇒ bỏ qua bước xác nhận, sang baselining", async () => {
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || !prompt.includes("# Import Extract")) return out
      const json = JSON.parse(out) as { items: { field_confidence: Record<string, number> }[] }
      for (const i of json.items) i.field_confidence = {}
      return JSON.stringify(json)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("baselining")
  })

  it("độ tin cả item 0.69 ⇒ mọi field của item cần xác nhận", async () => {
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || sectionOf(prompt) !== "fixed:3.1.2") return out
      const json = JSON.parse(out) as { items: { confidence: number }[] }
      for (const i of json.items) i.confidence = 0.69
      return JSON.stringify(json)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    const s = run.sections.find((x) => x.section_id === "fixed:3.1.2")!
    expect(s.fields_needing_review).toBe(s.fields_total)
    expect(s.fields_total).toBe(2)
  })
})

describe("I-4 — hết credit, resume", () => {
  it("hết credit ⇒ paused credits, giữ cursor ở section đang dở; nạp rồi resume không trích lại section done", async () => {
    // 5 credit: đủ 2 lượt (fixed:1, fixed:2.2.1), lượt thứ 3 (fixed:3.1.2) thiếu
    const ctx = await importAtExtracting({ balance: 5 })
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.status).toBe("extracting")
    expect(first.doc.paused?.reason).toBe("credits")
    expect(first.doc.extract_cursor).toBe(AI_ORDER[2])
    expect(calls).toEqual(AI_ORDER.slice(0, 2))
    const done = first.sections.filter((s) => s.status === "done").map((s) => s.section_id)
    expect(done).toEqual(expect.arrayContaining([...AI_ORDER.slice(0, 2), "fixed:2.1", "fixed:2.2.2"]))
    // section đang dở vì credit vẫn `pending` (không `failed`), lượt reserve bị huỷ, ví không giữ tiền treo
    expect(first.sections.find((s) => s.section_id === AI_ORDER[2])?.status).toBe("pending")
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 1, reserved: 0 })
    const persisted = await ImportedDocument.findById(ctx.importId).lean()
    expect(persisted).toMatchObject({ extract_cursor: AI_ORDER[2], paused: { reason: "credits" } })

    const snapshot = new Map((await draftsOf(ctx.importId)).filter((d) => d.status === "done").map((d) => [d.section_id, JSON.stringify(d.fields)]))
    await CreditWallet.updateOne({ userId: ctx.userId }, { $set: { balance: 1000 } })
    calls = []
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(resumed.doc.paused).toBeNull()
    expect(resumed.doc.extract_cursor).toBeNull()
    expect(resumed.doc.status).toBe("fields_review")
    for (const s of done) expect(calls, s).not.toContain(s)
    expect(calls[0]).toBe(AI_ORDER[2])
    expect(calls).toHaveLength(4)
    // field của section đã xong không bị ghi lại
    const after = await draftsOf(ctx.importId)
    for (const [s, fields] of snapshot) expect(JSON.stringify(after.find((d) => d.section_id === s)!.fields), s).toBe(fields)
  })

  it("resume khi mọi section đã xong ⇒ không gọi AI lần nào", async () => {
    const ctx = await importAtExtracting()
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    // đưa về extracting (như job bị mất sau khi xong hết section)
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { status: "extracting" } })
    calls = []
    const again = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls).toEqual([])
    expect(again.doc.status).toBe("fields_review")
  })
})

describe("I-4 — lỗi AI", () => {
  it("provider lỗi giữa chừng ⇒ release hold: ví hoàn phần giữ, usage refunded; resume trích lại section failed", async () => {
    mockOverrides.next = record((prompt) => (prompt.includes("# Import Extract") && sectionOf(prompt) === AI_ORDER[2] ? new Error("provider down") : fakeMode1(prompt)))
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.paused?.reason).toBe("resume_later")
    expect(run.doc.extract_cursor).toBe(AI_ORDER[2])
    expect(run.sections.find((s) => s.section_id === AI_ORDER[2])).toMatchObject({ status: "failed", error: expect.stringContaining("provider down") })
    // 2 lượt thành công đã trừ, lượt lỗi được hoàn: không còn credit treo
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 996, reserved: 0 })
    expect(await Usage.find({ projectId: ctx.projectId, step_id: `I-4:${AI_ORDER[2]}` }).distinct("state")).toEqual(["refunded"])
    expect(await Usage.countDocuments({ projectId: ctx.projectId, state: "reserved" })).toBe(0)

    mockOverrides.next = record(fakeMode1)
    calls = []
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls[0]).toBe(AI_ORDER[2])
    expect(resumed.sections.every((s) => s.status === "done")).toBe(true)
    expect(resumed.doc.status).toBe("fields_review")
  })

  it("import không ở extracting ⇒ IMPORT_INVALID_STATE, không gọi AI", async () => {
    const ctx = await importAtExtracting()
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { status: "fields_review" } })
    await expect(runExtraction(ctx.projectId, ctx.userId, ctx.importId)).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
    expect(calls).toEqual([])
  })
})
