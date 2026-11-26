/**
 * FLF-458 - tài liệu tham khảo đang chờ đọc được tính vào màn đọc khung và đọc cùng lượt Bắt đầu (business-flow §2 "báo trước,
 * xác nhận mới chạy"). Thiếu credit ⇒ 402 TRƯỚC khi viết lại file (Bỏ chữ) hay trừ credit: file, chữ Bỏ chữ, tài liệu `pending` nguyên vẹn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { AiActionLog } from "../../../src/modules/admin/ai-action-log.model.js"
import { ActionType } from "../../../src/shared/ai/ai-action.types.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { ProjectDocument } from "../../../src/modules/project/project-document.model.js"
import { waitForExtraction } from "../../../src/modules/import/extract-jobs.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (prompt) => (prompt.includes("Summarize the following document content") ? JSON.stringify({ summary: "Tóm tắt giả." }) : fakeMode1(prompt))
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

const setup = async () => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Warehouse XYZ", has_srs_file: true })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(WRITTEN_SRS), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  const importId = String(uploaded.body.data.import.id)
  const view = async () => (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data
  const baseline = await view()
  const keys = (baseline.text_sections as { key: string }[]).map((s) => s.key)
  const dropped = await request(app).patch(`/api/v1/projects/${projectId}/import/drop-text`).set(H(seeded)).send({ import_id: importId, keys })
  expect(dropped.status, JSON.stringify(dropped.body.error)).toBe(200)
  const withoutRefs = (await view()).credit_estimate
  for (const n of [1, 2]) {
    await ProjectDocument.create({
      projectId,
      uploadedBy: seeded.userId,
      fileName: `ref-${n}`,
      originalName: `ref-${n}.txt`,
      mimeType: "text/plain",
      size: 10,
      cloudinaryPublicId: `ref-${n}`,
      url: `https://example.test/ref-${n}.txt`,
      extractedText: `Biên bản ${n}`,
      parseStatus: "success",
      summaryStatus: "pending",
      docCode: n
    })
  }
  const start = () => request(app).post(`/api/v1/projects/${projectId}/import/extract`).set(H(seeded)).send({ import_id: importId, confirm_latest: true })
  const summarizeCalls = () => AiActionLog.countDocuments({ projectId, actionType: ActionType.SUMMARIZE_DOCUMENT })
  return { seeded, projectId, importId, view, withoutRefs, start, summarizeCalls }
}

describe("FLF-458 - đọc tài liệu tham khảo cùng lượt Bắt đầu", () => {
  it("GET /import: credit_estimate có reference_documents = 2 và reference_credits đã cộng vào credits", async () => {
    const { view, withoutRefs } = await setup()
    const est = (await view()).credit_estimate
    expect(est.reference_documents).toBe(2)
    expect(est.reference_credits).toBeGreaterThan(0)
    expect(est.credits - withoutRefs.credits).toBe(est.reference_credits)
    expect(est.ai_calls - withoutRefs.ai_calls).toBe(2)
  })

  it("đủ credit ⇒ Bắt đầu đọc cả 2 tài liệu, mỗi tài liệu đúng một lượt AI (không trừ hai lần)", async () => {
    const { projectId, importId, start, summarizeCalls } = await setup()
    const res = await start()
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    await waitForExtraction(importId)
    const docs = await ProjectDocument.find({ projectId }).lean()
    expect(docs.map((d) => d.summaryStatus)).toEqual(["success", "success"])
    expect(await summarizeCalls()).toBe(2)
  })

  it("thiếu credit ⇒ 402, file chưa viết lại, chữ Bỏ chữ còn, không trừ gì, tài liệu pending; nạp thêm rồi Bắt đầu lại được", async () => {
    const { seeded, projectId, importId, view, start, summarizeCalls } = await setup()
    const refCredits = (await view()).credit_estimate.reference_credits as number
    const before = await ImportedDocument.findById(importId).lean()
    const dropBefore = (await TemplateProfile.findOne({ projectId }).lean())!.drop_text
    expect(dropBefore?.length).toBeGreaterThan(0)

    // Đủ cho một tài liệu nhưng không đủ cả hai
    await CreditWallet.updateMany({}, { $set: { balance: refCredits - 1, reserved: 0 } })
    const res = await start()
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("INSUFFICIENT_CREDIT")

    const after = await ImportedDocument.findById(importId).lean()
    expect(after!.file_ref).toBe(before!.file_ref)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.drop_text).toEqual(dropBefore)
    expect((await CreditWallet.findOne({}).lean())!.balance).toBe(refCredits - 1)
    expect(await summarizeCalls()).toBe(0)
    expect((await ProjectDocument.find({ projectId }).lean()).map((d) => d.summaryStatus)).toEqual(["pending", "pending"])

    await CreditWallet.updateMany({}, { $set: { balance: 5000 } })
    const retry = await start()
    expect(retry.status, JSON.stringify(retry.body.error)).toBe(200)
    await waitForExtraction(importId)
    expect(await summarizeCalls()).toBe(2)
    expect((await ImportedDocument.findById(importId).lean())!.file_ref).not.toBe(before!.file_ref)
    void seeded
  })
})
