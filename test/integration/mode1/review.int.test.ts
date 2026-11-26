/**
 * FLF-453 (business-flow §3.1.2 "Rà soát phần có sẵn") trên Mongo thật: I-5 chạy luật Code rồi chọn mục cho AI rà trước
 * khi chế độ 3/4 sang Luồng 2 — 4 nhánh của "Hoàn thành khi": có mục đầu vào cần rà; có mục cờ đỏ; không mục nào cần rà
 * (bỏ qua vòng, sang thẳng Luồng 2); nghi sai nghiệp vụ ra 2 phương án + khuyến nghị. Cộng: từ chối credit không gọi AI,
 * bấm Dừng giữ tiến độ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining } from "../../helpers/mode1-import-p4.js"
import { styled, p } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { sectionsNeedingAiReview } from "../../../src/modules/import/review.service.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const version = async (projectId: string) => (await spineRepository.get(projectId))!.spine_version

const asHttp = async (projectId: string, userId: string) => {
  const user = (await User.findById(userId).lean())!
  const project = (await Project.findById(projectId).lean())!
  const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
  return { Authorization: `Bearer ${token}` }
}

/** Lên `incomplete`, áp ý định rồi finalize — không tự chạy vòng rà soát (khác `finishReviewIfPending` của helper chung). */
const toReviewGate = async (intent: "fixed" | "free", opts: Parameters<typeof importAtBaselining>[0] = {}) => {
  const ctx = await importAtBaselining(opts)
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: intent, start_kind: intent === "fixed" ? "new" : "existing" } })
  await startFinalize(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: await version(ctx.projectId) })
  await waitForFinalize(ctx.importId)
  return ctx
}

describe("FLF-453 - nhánh 1: có mục đầu vào cần rà (Product Overview feeds Brief)", () => {
  it("file giữ khung còn thiếu, Product Overview có sẵn ⇒ dừng ở reviewing, review_sections có fixed:1, báo credit trước khi chạy", async () => {
    const { projectId, importId, userId } = await toReviewGate("fixed", {
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") }
    })
    const doc = (await ImportedDocument.findById(importId))!
    expect(doc.status).toBe("reviewing")
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.review_sections).toContain("fixed:1")
    // Đối chiếu hàm thuần với chính target_structure + flags đã lưu
    const spine = (await spineRepository.get(projectId))!
    expect(sectionsNeedingAiReview(profile.target_structure!, spine.flags)).toEqual(expect.arrayContaining(profile.review_sections!))

    // Báo credit trước khi chạy (business-flow §2 "Báo trước khi chạy hàng loạt")
    const headers = await asHttp(projectId, userId)
    const view = await request(app).get(`/api/v1/projects/${projectId}/import`).set(headers)
    expect(view.status).toBe(200)
    expect(view.body.data.review).toMatchObject({ section_ids: profile.review_sections })
    expect(view.body.data.review.credits).toBeGreaterThan(0)

    // Xác nhận chạy ⇒ AI giả không phát hiện gì ⇒ sang Luồng 2
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data).toMatchObject({ project_mode: "fpt", import_state: "drafting" })
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")
  })
})

describe("FLF-453 - nhánh 2: có mục cờ đỏ (Code bắt ở I-5)", () => {
  it("function có chữ mơ hồ (vague_wording, đỏ, Tầng 3) ⇒ mục đó vào review_sections dù không phải đầu vào", async () => {
    mockOverrides.next = (prompt) => {
      if (prompt.includes("# Import Extract") && /Section \(registry id\): function:/.test(prompt)) {
        const b = /\[(B\d{4,})\]/.exec(prompt)?.[1] ?? "B0001"
        return JSON.stringify({
          section_id: /Section \(registry id\): (\S+)/.exec(prompt)![1],
          items: [
            {
              entity: "functions",
              key: null,
              value: { trigger: "The system should respond fast", normal: ["Enter email", "Submit"], abnormal: ["Wrong password"] },
              confidence: 0.9,
              field_confidence: {},
              source_block_ids: [b]
            }
          ],
          unmapped_block_ids: []
        })
      }
      return fakeMode1(prompt)
    }
    const { projectId, importId } = await toReviewGate("fixed", {
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") }
    })
    const doc = (await ImportedDocument.findById(importId))!
    expect(doc.status).toBe("reviewing")
    const spine = (await spineRepository.get(projectId))!
    const redFlag = spine.flags.find((f) => f.rule_id === "vague_wording" && f.level === "red" && f.resolved_at === null)
    expect(redFlag, JSON.stringify(spine.flags)).toBeTruthy()
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.review_sections).toContain(redFlag!.section_id)
  })
})

describe("FLF-453 - nhánh 3: không mục nào cần rà ⇒ bỏ qua vòng rà soát", () => {
  const REPORT3_TEMPLATE = new URL("../../../fixtures/fpt-report3-blank-template.docx", import.meta.url)

  it("mẫu trống, Bỏ tất cả ở màn đọc khung ⇒ không mục nào có chữ ⇒ không dừng ở reviewing, sang thẳng Luồng 2 như trước FLF-453", async () => {
    const seeded = await (await import("../../setup.js")).seedFixture("minimal", { balance: 1000 })
    const created = await request(app).post("/api/v1/projects").set({ Authorization: `Bearer ${seeded.token}` }).send({ name: "Khung mẫu", has_srs_file: true })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const projectId = String(created.body.data._id)
    const { readFile } = await import("node:fs/promises")
    const uploaded = await request(app)
      .post(`/api/v1/projects/${projectId}/import`)
      .set({ Authorization: `Bearer ${seeded.token}` })
      .attach("file", await readFile(REPORT3_TEMPLATE), "Report3.docx")
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
    const importId = String(uploaded.body.data.import.id)
    const initial = (await request(app).get(`/api/v1/projects/${projectId}/import`).set({ Authorization: `Bearer ${seeded.token}` })).body.data
    const keys = (initial.text_sections as { key: string }[]).map((s) => s.key)
    const dropped = await request(app)
      .patch(`/api/v1/projects/${projectId}/import/drop-text`)
      .set({ Authorization: `Bearer ${seeded.token}` })
      .send({ import_id: importId, keys })
    expect(dropped.status, JSON.stringify(dropped.body.error)).toBe(200)
    const { applyDropText } = await import("../../../src/modules/import/import.service.js")
    await applyDropText((await ImportedDocument.findById(importId))!)
    const { acceptLatest } = await import("../../../src/modules/import/import.service.js")
    await acceptLatest((await ImportedDocument.findById(importId))!, true)
    const { runExtraction } = await import("../../../src/modules/import/extract.service.js")
    await runExtraction(projectId, seeded.userId, importId)
    await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: await version(projectId) })
    await waitForFinalize(importId)
    const after = (await ImportedDocument.findById(importId))!
    // Không có mục có sẵn nào (toàn Bỏ chữ) ⇒ không có đầu vào, không có cờ đỏ ⇒ không dừng ở reviewing
    expect(after.status).not.toBe("reviewing")
  })
})

describe("FLF-453 - nhánh 4: nghi sai nghiệp vụ ra 2 phương án + khuyến nghị", () => {
  it("AI rà trả rule business_logic_suspicion ⇒ cờ vàng mang cả hai phương án và khuyến nghị trong message", async () => {
    const SUSPICION = "Bước duyệt bỏ qua vai trò Quản lý. Phương án A: giữ như file (rủi ro: vượt quyền), ưu điểm nhanh. Phương án B: thêm bước duyệt của Quản lý, ưu điểm đúng quy trình, nhược điểm chậm hơn. Khuyến nghị: B vì đúng quy trình đã ký kết."
    const { projectId, importId, userId } = await toReviewGate("fixed", {
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") }
    })
    expect((await ImportedDocument.findById(importId))!.status).toBe("reviewing")
    mockOverrides.next = (prompt) =>
      prompt.includes("# Import Review Existing")
        ? JSON.stringify({ findings: [{ rule: "business_logic_suspicion", section_id: "fixed:1", message: SUSPICION, block_ids: [] }] })
        : fakeMode1(prompt)
    const headers = await asHttp(projectId, userId)
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    const spine = (await spineRepository.get(projectId))!
    const flag = spine.flags.find((f) => f.rule_id === "import_review")
    expect(flag).toBeTruthy()
    expect(flag!.level).toBe("yellow")
    expect(flag!.message).toContain("Phương án A")
    expect(flag!.message).toContain("Phương án B")
    expect(flag!.message).toContain("Khuyến nghị")
  })
})

describe("FLF-453 - từ chối credit / Dừng giữa chừng", () => {
  it("ví hết credit ⇒ không gọi AI thêm, giữ nguyên reviewing; bấm Dừng ⇒ paused: user, giữ tiến độ", async () => {
    const { projectId, importId, userId } = await toReviewGate("fixed", {
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") }
    })
    expect((await ImportedDocument.findById(importId))!.status).toBe("reviewing")
    const headers = await asHttp(projectId, userId)

    // Bấm Dừng trước khi xác nhận ⇒ giữ reviewing, không có cờ nào được ghi (không gọi AI)
    const stop = await request(app).post(`/api/v1/projects/${projectId}/import/review/stop`).set(headers).send({ import_id: importId })
    expect(stop.status, JSON.stringify(stop.body.error)).toBe(200)
    expect(stop.body.data.import).toMatchObject({ status: "reviewing", paused: { reason: "user" } })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.flags.filter((f) => f.rule_id === "import_review")).toHaveLength(0)

    // Hết ví: trừ hết credit org trước khi xác nhận chạy ⇒ hết credit, không mất gì đã có
    const project = (await Project.findById(projectId).lean())!
    await CreditWallet.updateOne({ organizationId: project.organizationId }, { $set: { balance: 0 } })
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data.import.status).toBe("reviewing")
    expect(run.body.data.import.paused).toMatchObject({ reason: "credits" })
  })
})

describe("FLF-453 - nút Rà soát bằng AI cho từng mục chỉ được Code kiểm", () => {
  const SRS = { srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } }
  const url = (projectId: string, tail: string) => `/api/v1/projects/${projectId}/import/${tail}`

  /** Đưa fixed:1 ra khỏi nhóm AI tự rà ⇒ thành mục chỉ Code kiểm. */
  const toOptional = async () => {
    const ctx = await toReviewGate("fixed", SRS)
    await TemplateProfile.updateOne({ projectId: ctx.projectId }, { $set: { review_sections: [] } })
    return { ...ctx, headers: await asHttp(ctx.projectId, ctx.userId) }
  }

  it("báo credit riêng của mục, chưa xác nhận thì không gọi AI và không trừ; mục Ngoài phạm vi không được đề nghị", async () => {
    const { projectId, importId, headers } = await toOptional()
    let aiCalls = 0
    mockOverrides.next = (prompt) => {
      if (prompt.includes("# Import Review Existing")) aiCalls++
      return fakeMode1(prompt)
    }
    const view = await request(app).get(url(projectId, "")).set(headers)
    const opt = view.body.data.review.optional_sections as { section_id: string; calls: number; credits: number }[]
    expect(opt.map((o) => o.section_id)).toContain("fixed:1")
    const mine = opt.find((o) => o.section_id === "fixed:1")!
    expect(mine.credits).toBeGreaterThan(0)

    const project = (await Project.findById(projectId).lean())!
    const before = (await CreditWallet.findOne({ organizationId: project.organizationId }).lean())!.balance
    const quote = await request(app).post(url(projectId, "review/section")).set(headers).send({ import_id: importId, section_id: "fixed:1" })
    expect(quote.status, JSON.stringify(quote.body.error)).toBe(200)
    expect(quote.body.data).toMatchObject({ section_id: "fixed:1", credits: mine.credits, reviewed: false })
    expect(aiCalls).toBe(0)
    expect((await CreditWallet.findOne({ organizationId: project.organizationId }).lean())!.balance).toBe(before)

    // Ngoài phạm vi ⇒ không còn đề nghị, xác nhận trực tiếp bị từ chối
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    await TemplateProfile.updateOne(
      { projectId },
      { $set: { "target_structure.sections": profile.target_structure!.sections.map((s) => (s.section_id === "fixed:1" ? { ...s, status: "out_of_scope" } : s)) } }
    )
    const denied = await request(app).post(url(projectId, "review/section")).set(headers).send({ import_id: importId, section_id: "fixed:1", confirm: true })
    expect(denied.status).toBe(409)
    expect(aiCalls).toBe(0)
  })

  it("xác nhận ⇒ chạy, ghi cờ import_review, vẫn reviewing, prompt không có chữ hướng dẫn; chạy lại không còn đề nghị", async () => {
    const { projectId, importId, headers } = await toOptional()
    const prompts: string[] = []
    mockOverrides.next = (prompt) => {
      if (!prompt.includes("# Import Review Existing")) return fakeMode1(prompt)
      prompts.push(prompt)
      return JSON.stringify({ findings: [{ rule: "business_logic_suspicion", section_id: "fixed:1", message: "Nghi sai nghiệp vụ. Phương án A, Phương án B. Khuyến nghị: B.", block_ids: [] }] })
    }
    const run = await request(app).post(url(projectId, "review/section")).set(headers).send({ import_id: importId, section_id: "fixed:1", confirm: true })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data).toMatchObject({ reviewed: true, import: { status: "reviewing" } })
    expect(prompts.length).toBeGreaterThan(0)
    for (const pr of prompts) expect(pr).not.toContain("[Describe the conventions.]")
    const spine = (await spineRepository.get(projectId))!
    const flag = spine.flags.find((f) => f.rule_id === "import_review")
    expect(flag).toBeTruthy()
    expect(flag!.level).toBe("yellow")
    const view = await request(app).get(url(projectId, "")).set(headers)
    expect((view.body.data.review.optional_sections as { section_id: string }[]).map((o) => o.section_id)).not.toContain("fixed:1")
  })

  it("hết credit ⇒ paused credits, vẫn reviewing, không cờ nào", async () => {
    const { projectId, importId, headers } = await toOptional()
    const project = (await Project.findById(projectId).lean())!
    await CreditWallet.updateOne({ organizationId: project.organizationId }, { $set: { balance: 0 } })
    const run = await request(app).post(url(projectId, "review/section")).set(headers).send({ import_id: importId, section_id: "fixed:1", confirm: true })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data).toMatchObject({ reviewed: false, import: { status: "reviewing", paused: { reason: "credits" } } })
    expect((await spineRepository.get(projectId))!.flags.filter((f) => f.rule_id === "import_review")).toHaveLength(0)
  })
})
