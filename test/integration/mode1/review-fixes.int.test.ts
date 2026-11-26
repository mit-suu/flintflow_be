/**
 * FLF-453 (sửa sau review nhóm B): cờ vòng rà soát không bị recompute đóng, lô lỗi không làm mất kết quả lô khác,
 * chữ hướng dẫn lớp 1-3 không vào prompt, nút Dừng ở `reviewing` dừng thật.
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
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import * as flagsService from "../../../src/modules/spine/flags.service.js"
import { IMPORTED_DOC_VERSION } from "../../../src/modules/doc-version/versioning.js"

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

const toReview = async () => {
  const ctx = await importAtBaselining({ srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } })
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: "fixed", start_kind: "new" } })
  await startFinalize(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: await version(ctx.projectId) })
  await waitForFinalize(ctx.importId)
  expect((await ImportedDocument.findById(ctx.importId))!.status).toBe("reviewing")
  return ctx
}

/** Nối `count` block dài vào mục Product Overview (đầu vào của phần thiếu) để vòng rà soát cần nhiều lô. */
const addBlocks = async (projectId: string, count: number, extra: (i: number) => Record<string, unknown> = () => ({})) => {
  const last = (await DocBlock.findOne({ projectId, doc_version: IMPORTED_DOC_VERSION }).sort({ "anchor.ordinal": -1 }).lean())!
  await DocBlock.insertMany(
    Array.from({ length: count }, (_, i) => ({
      projectId: last.projectId,
      doc_version: IMPORTED_DOC_VERSION,
      block_id: `B${9000 + i}`,
      kind: "paragraph",
      anchor: { xml_path: `/extra/${i}`, ordinal: last.anchor.ordinal + 1 + i },
      text: `${i === 0 ? "HEAD-MARKER " : ""}${"The system shall keep records as needed. ".repeat(48)}`,
      text_hash: `extra-${i}`,
      section_id: "fixed:1",
      ...extra(i)
    }))
  )
}

const finding = (message: string) => JSON.stringify({ findings: [{ rule: "business_logic_suspicion", section_id: "fixed:1", message, block_ids: [] }] })

describe("FLF-453 sửa lỗi", () => {
  it("cờ import_review còn mở sau recompute", async () => {
    const { projectId, importId, userId } = await toReview()
    mockOverrides.next = (prompt) => (prompt.includes("# Import Review Existing") ? finding("Phương án A hoặc B, khuyến nghị B.") : fakeMode1(prompt))
    const headers = await asHttp(projectId, userId)
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    await flagsService.recompute(projectId, { by: "import" })
    const flags = (await spineRepository.get(projectId))!.flags.filter((f) => f.rule_id === "import_review")
    expect(flags.length).toBeGreaterThan(0)
    expect(flags.every((f) => f.resolved_at === null)).toBe(true)
  })

  it("một lô lỗi ⇒ phát hiện của lô khác vẫn được ghi, paused, chưa sang Luồng 2", async () => {
    const { projectId, importId, userId } = await toReview()
    await addBlocks(projectId, 40)
    mockOverrides.next = (prompt) => {
      if (!prompt.includes("# Import Review Existing")) return fakeMode1(prompt)
      return prompt.includes("HEAD-MARKER") ? new Error("provider down") : finding("Nghi sai nghiệp vụ ở lô khác.")
    }
    const headers = await asHttp(projectId, userId)
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data.import).toMatchObject({ status: "reviewing", paused: { reason: "resume_later" } })
    const flags = (await spineRepository.get(projectId))!.flags.filter((f) => f.rule_id === "import_review")
    expect(flags.length).toBeGreaterThan(0)
  })

  it("chữ hướng dẫn lớp 1-3 không vào prompt rà soát", async () => {
    const { projectId, importId, userId } = await toReview()
    await addBlocks(projectId, 1, () => ({ guidance_layer: 1, text: "GUIDANCE-ONLY-MARKER describe the overview here" }))
    const prompts: string[] = []
    mockOverrides.next = (prompt) => {
      if (prompt.includes("# Import Review Existing")) prompts.push(prompt)
      return fakeMode1(prompt)
    }
    const headers = await asHttp(projectId, userId)
    await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.some((s) => s.includes("GUIDANCE-ONLY-MARKER"))).toBe(false)
  })

  it("bấm Dừng khi đang rà ⇒ không mở lô mới, giữ paused user, không sang Luồng 2", async () => {
    const { projectId, importId, userId } = await toReview()
    await addBlocks(projectId, 60)
    let calls = 0
    mockOverrides.before = async (prompt) => {
      if (!prompt.includes("# Import Review Existing")) return
      calls++
      await ImportedDocument.updateOne({ _id: importId }, { $set: { paused: { reason: "user", at: new Date() } } })
    }
    const headers = await asHttp(projectId, userId)
    const run = await request(app).post(`/api/v1/projects/${projectId}/import/review/run`).set(headers).send({ import_id: importId })
    expect(run.status, JSON.stringify(run.body.error)).toBe(200)
    expect(run.body.data.import).toMatchObject({ status: "reviewing", paused: { reason: "user" } })
    expect(calls).toBeLessThanOrEqual(3)
    const done = await Usage.countDocuments({ projectId, step_id: /^I-1\.11r/, state: "deducted" })
    expect(done).toBeLessThanOrEqual(3)
    expect((await ImportedDocument.findById(importId))!.status).toBe("reviewing")
  })
})

describe("FLF-453 - rà luật Code (I-5) lỗi lúc finalize", () => {
  it("recompute lỗi ⇒ vẫn dừng ở reviewing với mục đầu vào, không bỏ qua vòng rà soát", async () => {
    const spy = vi.spyOn(flagsService, "recompute").mockRejectedValueOnce(new Error("recompute down"))
    try {
      const { projectId } = await toReview()
      const { TemplateProfile } = await import("../../../src/modules/import/template-profile.model.js")
      const profile = (await TemplateProfile.findOne({ projectId }).lean())!
      expect(profile.review_sections).toContain("fixed:1")
    } finally {
      spy.mockRestore()
    }
  })
})
