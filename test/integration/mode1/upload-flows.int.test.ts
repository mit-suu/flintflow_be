/**
 * FLF-411 — ba luồng upload SRS (hộp Tạo dự án), chạy trọn upload ⇒ màn đọc khung ⇒ đọc nội dung ⇒ finalize trên file thật:
 *
 * 1. Up **template trống** (giữ khung) ⇒ khung mẫu: không trích chữ / hình mẫu, soạn đủ mọi mục (luồng C), không dữ liệu ví dụ.
 * 2. Up **SRS có sẵn, không tick** "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow" ⇒ giữ đúng khung file (chế độ 1 khi đủ mục).
 * 3. Up **SRS có sẵn, tick** ⇒ đích là mẫu FlintFlow (bổ sung mục thiếu).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { acceptLatest } from "../../../src/modules/import/import.service.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const REPORT3_TEMPLATE = new URL("../../../fixtures/fpt-report3-blank-template.docx", import.meta.url)
const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)

const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

const create = async (body: Record<string, unknown>) => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Upload flow", ...body })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  return { seeded, projectId: String(created.body.data._id), project: created.body.data }
}

/** Upload ⇒ màn đọc khung ⇒ Bắt đầu (đọc nội dung) ⇒ finalize. */
const uploadAndFinalize = async (file: URL, completeToStandard: boolean) => {
  const { seeded, projectId } = await create({ has_srs_file: true, complete_to_standard: completeToStandard })
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(file), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  const importId = String(uploaded.body.data.import.id)
  const preview = (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data.structure_preview
  const doc = (await ImportedDocument.findById(importId))!
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, importId)
  const usageAfterRead = await Usage.countDocuments({ projectId })
  await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
  await waitForFinalize(importId)
  const project = (await Project.findById(projectId).lean())!
  const spine = (await spineRepository.get(projectId))!
  const profile = (await TemplateProfile.findOne({ projectId }).lean())!
  return { seeded, projectId, preview, usageAfterRead, project, spine, profile, status: (await ImportedDocument.findById(importId))!.status }
}

describe("FLF-411 - ba luồng upload", () => {
  it("1. up template trống (giữ khung) ⇒ khung mẫu, không đọc nội dung bằng AI, Spine không có dữ liệu ví dụ, soạn đủ từ đầu", async () => {
    const r = await uploadAndFinalize(REPORT3_TEMPLATE, false)
    expect(r.preview.summary).toMatchObject({ kind: "template", present: 0 })
    expect(r.preview.intent).toBe("fixed")
    // Không gọi AI đọc chữ / hình mẫu
    expect(r.usageAfterRead).toBe(0)
    // Không dữ liệu Cafeteria của mẫu
    expect(r.spine.project.system_name ?? null).toBeNull()
    expect(r.spine.actors).toHaveLength(0)
    expect(r.spine.use_cases).toHaveLength(0)
    expect(r.spine.screens).toHaveLength(0)
    expect(r.spine.business_rules).toHaveLength(0)
    expect(r.spine.entities).toHaveLength(0)
    // Luồng C: soạn trong workspace, không bước nội dung nào chốt sẵn
    expect(r.project).toMatchObject({ mode: "fpt", template_intent: "fixed" })
    expect(r.status).toBe("drafting")
    // S-8.3 (Record of Changes) không phải mục soạn của mẫu — chốt sẵn như mọi dự án import
    const accepted = r.spine.steps.filter((s) => s.status === "accepted" && /^S-/.test(s.id) && s.id !== "S-8.3")
    expect(accepted.map((s) => s.id)).toEqual([])
  }, 120000)

  it("2. up SRS có sẵn, không tick ⇒ giữ đúng khung file: SRS đã viết, đủ mục ⇒ chế độ 1, dữ liệu trích từ file", async () => {
    const r = await uploadAndFinalize(WRITTEN_SRS, false)
    expect(r.preview.summary).toMatchObject({ kind: "written", missing: 0 })
    expect(r.preview.intent).toBe("fixed")
    expect(r.profile.target_structure?.resolved_mode).toBe(1)
    expect(r.project.mode).toBe("import")
    expect(r.spine.actors.length).toBeGreaterThan(0)
  }, 120000)

  it("3. up SRS có sẵn, tick Bổ sung theo mẫu chuẩn ⇒ đích là mẫu FlintFlow", async () => {
    const r = await uploadAndFinalize(WRITTEN_SRS, true)
    expect(r.preview.intent).toBe("free")
    expect(r.preview.summary.kind).toBe("written")
    expect([1, 4]).toContain(r.profile.target_structure?.resolved_mode)
    expect(r.spine.actors.length).toBeGreaterThan(0)
  }, 120000)

  it("1b. up template trống, tick Bổ sung theo mẫu chuẩn ⇒ vẫn là khung mẫu, không nhập chữ / hình ví dụ của mẫu làm dữ liệu", async () => {
    const r = await uploadAndFinalize(REPORT3_TEMPLATE, true)
    expect(r.preview.intent).toBe("free")
    expect(r.preview.summary.kind).toBe("template")
    expect(r.spine.project.system_name ?? null).toBeNull()
    expect(r.spine.actors).toHaveLength(0)
    expect(r.spine.use_cases).toHaveLength(0)
    expect(r.spine.screens).toHaveLength(0)
  }, 120000)
})
