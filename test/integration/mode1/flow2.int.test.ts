/**
 * FLF-278 trên FLF-335/336 — chế độ 3 (mẫu bắt buộc còn thiếu mục) đi tiếp Luồng 2 thay vì "Hoàn thiện", Mongo thật:
 * `incomplete` ⇒ `POST /import/continue` ⇒ dự án sang pipeline tạo mới (`mode = fpt`, `import_state = drafting`), Brief mở lại
 * từ B-1.1, bước mục thiếu chờ chạy, chạy step được; bản in vẫn theo mẫu (không thêm mục ngoài mẫu). Ý định tự do ⇒ từ chối.
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
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { ruleProfileOf } from "../../../src/modules/import/mode1-guard.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const version = async (projectId: string) => (await spineRepository.get(projectId))!.spine_version
const toIncomplete = async (intent: "fixed" | "free") => {
  const ctx = await importAtBaselining({ srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } })
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: intent, start_kind: intent === "fixed" ? "new" : "existing" } })
  await startFinalize(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: await version(ctx.projectId) })
  await waitForFinalize(ctx.importId)
  expect((await ImportedDocument.findById(ctx.importId))!.status).toBe("incomplete")
  const user = (await User.findById(ctx.userId).lean())!
  const project = (await Project.findById(ctx.projectId).lean())!
  const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
  return { ...ctx, token }
}

describe("Luồng 2 cho phần thiếu — chế độ 3", () => {
  it("incomplete ⇒ continue ⇒ mode fpt + drafting, Brief từ B-1.1, chạy step được, bản in theo mẫu", async () => {
    const { projectId, importId, token } = await toIncomplete("fixed")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ project_mode: "fpt", import_state: "drafting", current_step: "B-1.1" })

    const project = (await Project.findById(projectId).lean())!
    expect(project).toMatchObject({ mode: "fpt", import_state: "drafting", template_intent: "fixed" })
    expect(project.documentLanguage).toBeTruthy()
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")

    const spine = (await spineRepository.get(projectId))!
    const status = (id: string) => spine.steps.find((s) => s.id === id)?.status
    expect(status("B-0.1")).toBe("skipped")
    expect(status("B-1.1")).toBe("pending")
    expect(status("S-1.1")).toBe("pending")
    expect(spine.progress.current_step).toBe("B-1.1")

    // Không còn bị chặn MODE1_NO_STEPS — workspace chạy step như dự án tạo mới
    const steps = await request(app).get(`/api/v1/projects/${projectId}/steps`).set({ Authorization: `Bearer ${token}` })
    expect(steps.status, JSON.stringify(steps.body.error)).toBe(200)

    // Luật cờ: đủ luật tạo mới, chỉ trên mục của mẫu
    const profile = await ruleProfileOf(projectId)
    expect(profile?.templateLayout?.size).toBeGreaterThan(0)
    expect(profile?.exclude.size).toBe(0)

    const layoutIds = new Set(((await TemplateProfile.findOne({ projectId }).lean())!.layout ?? []).map((l) => l.section_id))
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(doc.sections.filter((s) => s.id.startsWith("fixed:") && s.id !== "fixed:I" && !layoutIds.has(s.id))).toEqual([])
  })

  it("ý định tự do (chế độ 4) ⇒ 409 IMPORT_INVALID_STATE, dự án giữ nguyên", async () => {
    const { projectId, importId, token } = await toIncomplete("free")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
    expect((await Project.findById(projectId).lean())!.mode).toBe("import")
  })
})
