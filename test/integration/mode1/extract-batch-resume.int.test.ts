/**
 * I-4: chạy tiếp theo từng lượt AI (section nhiều lô dừng ở lô k ⇒ không gọi / trừ lại lô trước). Mongo thật + provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { AI_BLOCK_CHARS, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

/** Lượt gọi provider (kể cả retry): section + đoạn đánh dấu lô (`P01`…) có trong prompt. */
let calls: { section: string; marks: string[]; image: boolean }[] = []
const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
const record = (fn: (prompt: string) => string | Error | undefined) => (prompt: string) => {
  if (prompt.includes("# Import Extract") || prompt.includes("# Read Diagram Image"))
    calls.push({ section: sectionOf(prompt), marks: [...prompt.matchAll(/MARK-P(\d\d)/g)].map((m) => m[1]), image: prompt.includes("# Read Diagram Image") })
  return fn(prompt)
}

beforeEach(() => {
  resetMockLlm()
  calls = []
  mockOverrides.next = record(fakeMode1)
})

/** 10 đoạn ~5,9k ký tự ở mục 1 ⇒ ngân sách 24k chia 3 lô: [mục đích, P01–P04], [P05–P08], [P09–P10]. */
const LONG_OVERVIEW = Array.from({ length: 10 }, (_, i) => {
  const mark = `MARK-P${String(i + 1).padStart(2, "0")} `
  return mark + "Lumen keeps course material organised for small centres. ".repeat(Math.floor((AI_BLOCK_CHARS - 200) / 58))
})
const LONG = { srs: { overviewParagraphs: LONG_OVERVIEW } }

const wallet = async (userId: string) => CreditWallet.findOne({ userId }).lean()
const snapshot = async (importId: string) =>
  (await ExtractionDraft.find({ import_id: importId }).sort({ section_id: 1 }).lean()).map((d) => ({
    section_id: d.section_id,
    status: d.status,
    fields: d.fields,
    unmapped: d.unmapped_block_ids,
    images: d.diagram_images,
    partial: d.partial
  }))
const deducted = async (projectId: string, step: string) => Usage.countDocuments({ projectId, step_id: step, state: "deducted" })

describe("I-4 — chạy tiếp theo từng lô", () => {
  it("mục 3 lô, lô 2 lỗi ⇒ chạy tiếp từ lô 2: lô 1 không gọi lại, không trừ hai lần, kết quả như chạy một mạch", async () => {
    // chạy một mạch làm mốc
    const ref = await importAtExtracting(LONG)
    await runExtraction(ref.projectId, ref.userId, ref.importId)
    const overviewCalls = calls.filter((c) => c.section === "fixed:1")
    expect(overviewCalls.map((c) => c.marks[0])).toEqual(["01", "05", "09"])
    const expected = await snapshot(ref.importId)
    const refBalance = (await wallet(ref.userId))!.balance

    calls = []
    mockOverrides.next = record((prompt) => (sectionOf(prompt) === "fixed:1" && prompt.includes("MARK-P05") ? new Error("provider down") : fakeMode1(prompt)))
    const ctx = await importAtExtracting(LONG)
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("resume_later")
    expect(first.doc.extract_cursor).toBe("fixed:1")
    // lô 1 thành công (trừ 2 credit) + lô 2 lỗi (hoàn) — tiến độ lưu 1 lượt
    expect(calls.map((c) => c.marks[0])).toEqual(["01", "05"])
    expect(await deducted(ctx.projectId, "I-4:fixed:1")).toBe(1)
    const paused = (await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: "fixed:1" }).lean())!
    expect(paused).toMatchObject({ status: "failed", partial: { steps_done: 1 } })
    expect(paused.partial!.items.length).toBeGreaterThan(0)
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 998, reserved: 0 })

    calls = []
    mockOverrides.next = record(fakeMode1)
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: null } })
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(resumed.doc.status).toBe("fields_review")
    expect(calls.filter((c) => c.section === "fixed:1").map((c) => c.marks[0])).toEqual(["05", "09"])
    expect(calls).toHaveLength(7)
    expect(await deducted(ctx.projectId, "I-4:fixed:1")).toBe(3)
    expect(await Usage.countDocuments({ projectId: ctx.projectId, state: "reserved" })).toBe(0)
    // tổng tiền như chạy một mạch
    expect(await wallet(ctx.userId)).toMatchObject({ balance: refBalance, reserved: 0 })
    const after = await snapshot(ctx.importId)
    expect(after).toEqual(expected)
    expect(after.every((d) => d.partial === null && d.status === "done")).toBe(true)
  }, 60_000)

  it("hết credit giữa hai lô ⇒ section vẫn pending, chạy tiếp từ lô chưa trả tiền", async () => {
    // 3 credit: đủ lô 1 (2 credit), lô 2 thiếu
    const ctx = await importAtExtracting({ ...LONG, balance: 3 })
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.paused?.reason).toBe("credits")
    expect(calls.map((c) => c.marks[0])).toEqual(["01"])
    expect((await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: "fixed:1" }).lean())).toMatchObject({ status: "pending", partial: { steps_done: 1 } })

    await CreditWallet.updateOne({ userId: ctx.userId }, { $set: { balance: 1000 } })
    calls = []
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls.filter((c) => c.section === "fixed:1").map((c) => c.marks[0])).toEqual(["05", "09"])
    expect(await deducted(ctx.projectId, "I-4:fixed:1")).toBe(3)
  }, 60_000)
})
