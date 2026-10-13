/**
 * I-4: chạy tiếp theo từng lượt AI (section nhiều lô dừng ở lô k ⇒ không gọi / trừ lại lô trước) + ước tính credit trước
 * khi trích (`GET /import` → `credit_estimate`) khớp số lượt / credit thật. Mongo thật + provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { seedFixture } from "../../setup.js"
import { AI_BLOCK_CHARS, estimateExtraction, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { getImportResponseSchema } from "../../../src/modules/import/import.dto.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
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

    // ước tính lúc dừng = phần còn lại (2 lô của mục 1 + 5 mục chữ khác)
    expect(await estimateExtraction(ctx.projectId, first.doc)).toMatchObject({ text_batches: 7, diagram_images: 0, ai_calls: 7, credits: 14 })

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

describe("I-4 — ước tính credit", () => {
  const PNG = buildPlaceholderPng(12, 7, 0x40)
  const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0, 0, 0, 0])
  const IMAGES = {
    srs: {
      overviewParagraphs: LONG_OVERVIEW,
      images: [
        { name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG use case diagram" },
        // EMF không gửi được ⇒ không tính; ảnh chụp màn hình ⇒ `readsImage` bỏ
        { name: "image2.emf", data: EMF, caption: "Figure 2 Context diagram" },
        { name: "image3.png", data: PNG, caption: "Figure 3 Login screenshot" }
      ]
    }
  }

  it("ước tính = số lượt AI + credit thật của lượt chạy (lô chữ + ảnh đọc được)", async () => {
    const ctx = await importAtExtracting(IMAGES)
    const estimate = await estimateExtraction(ctx.projectId, { _id: ctx.importId } as never)
    const before = (await wallet(ctx.userId))!.balance
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    const charged = before - (await wallet(ctx.userId))!.balance
    expect(estimate).toEqual({
      text_batches: calls.filter((c) => !c.image).length,
      diagram_images: calls.filter((c) => c.image).length,
      ai_calls: calls.length,
      credits: charged
    })
    expect(estimate).toMatchObject({ text_batches: 8, diagram_images: 1 })
    expect(await Usage.countDocuments({ projectId: ctx.projectId, state: "deducted" })).toBe(calls.length)
    // xong hết ⇒ không còn gì phải chạy
    expect(await estimateExtraction(ctx.projectId, { _id: ctx.importId } as never)).toMatchObject({ ai_calls: 0, credits: 0 })
  }, 60_000)

  it("GET /import: mapping_review có ước tính + số dư ví org; Viewer không thấy số dư; sau khi trích xong ⇒ null", async () => {
    const seeded = await seedFixture("minimal", { balance: 7 })
    const projectId = await createMode1Project(seeded)
    const c = mode1Api(seeded, projectId)
    const id = (await c.upload(await makeSrsDocx({ numberedOnly: true }))).body.data.import.id as string
    expect((await c.post("/import/confirm-latest", { import_id: id })).body.data.import.status).toBe("mapping_review")

    const view = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(view.credit_estimate).toMatchObject({ ai_calls: expect.any(Number), available_credits: 7 })
    expect(view.credit_estimate!.credits).toBe(view.credit_estimate!.ai_calls * 2)

    await Membership.updateOne({ userId: seeded.userId }, { $set: { role: "viewer" } })
    const asViewer = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(asViewer.credit_estimate).toMatchObject({ ai_calls: view.credit_estimate!.ai_calls, available_credits: null })
    await Membership.updateOne({ userId: seeded.userId }, { $set: { role: "lead" } })

    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 1000 } })
    expect((await c.patch("/import/mapping", { import_id: id, confirm_all: true })).body.data.import.status).toBe("extracting")
    const ready = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(ready.credit_estimate).toMatchObject({ credits: view.credit_estimate!.credits, available_credits: 1000 })

    const ex = await c.extractAndWait(id)
    expect(ex.res.status).toBe(200)
    expect(calls).toHaveLength(ready.credit_estimate!.ai_calls)
    const done = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(done.import?.status).not.toBe("extracting")
    expect(done.credit_estimate).toBeNull()
  }, 60_000)
})
