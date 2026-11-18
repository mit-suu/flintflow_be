/**
 * Màn đọc khung (business-flow §3.1.2) trên Mongo thật: hộp Tạo dự án hai ô ⇒ upload ⇒ `GET /import` có cấu trúc đích sơ bộ
 * tính bằng Code (không gọi AI, không trừ credit), theo thứ tự file; gap report sơ bộ tải được trước Bắt đầu; `intent` client
 * cũ gửi kèm bị bỏ qua. Sau finalize, mục đổi trạng thái so với bản sơ bộ nằm ở `import.structure_changes`.
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
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const BLANK_TEMPLATE = new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url)

const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

const createAndUpload = async (body: Record<string, unknown>, file: URL) => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "FU Student Portal", ...body })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  // Client cũ gửi kèm `intent` — bị bỏ qua, ý định theo hộp Tạo dự án
  const uploaded = await request(app)
    .post(`/api/v1/projects/${projectId}/import`)
    .set(H(seeded))
    .field("intent", body.complete_to_standard ? "fixed" : "free")
    .attach("file", await readFile(file), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  return { seeded, projectId, importId: String(uploaded.body.data.import.id), intent: uploaded.body.data.import.intent as string }
}

describe("màn đọc khung - cấu trúc đích sơ bộ lúc upload", () => {
  it("SRS đã viết, giữ khung ⇒ written, phần lớn mục có nội dung; không gọi AI, không trừ credit; gap report sơ bộ tải được", async () => {
    const { seeded, projectId, intent } = await createAndUpload({ has_srs_file: true }, WRITTEN_SRS)
    expect(intent).toBe("fixed")
    const view = await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))
    expect(view.status).toBe(200)
    const preview = view.body.data.structure_preview
    expect(preview.summary.kind).toBe("written")
    expect(preview.intent).toBe("fixed")
    expect(preview.summary.present).toBeGreaterThan(preview.summary.missing)
    // Thứ tự file: `order` tăng dần
    const orders = preview.sections.map((s: { order: number }) => s.order)
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b))
    expect(await Usage.countDocuments({ projectId })).toBe(0)
    expect((await request(app).get("/api/v1/billing/balance").set(H(seeded))).body.data?.balance ?? 5000).toBe(5000)

    const report = await request(app).get(`/api/v1/projects/${projectId}/gap-report`).set(H(seeded))
    expect(report.status, JSON.stringify(report.body.error)).toBe(200)
    expect(report.body.data).toMatchObject({ preliminary: true, totals: { red: 0, yellow: 0 } })
    expect(report.body.data.target_structure.sections.length).toBe(preview.sections.length)
    const docx = await request(app).get(`/api/v1/projects/${projectId}/gap-report?format=docx`).set(H(seeded))
    expect(docx.status).toBe(200)
    // Tải báo cáo sơ bộ không đẩy import sang `delivered`
    expect((await ImportedDocument.findOne({ projectId }))!.status).toBe("extracting")
  })

  it("khung mẫu trống, giữ khung ⇒ template, mọi mục thiếu, chế độ 3", async () => {
    const { seeded, projectId } = await createAndUpload({ has_srs_file: true }, BLANK_TEMPLATE)
    const preview = (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data.structure_preview
    expect(preview.summary).toMatchObject({ kind: "template", present: 0 })
    expect(preview.summary.missing).toBeGreaterThan(5)
    expect(preview.resolved_mode).toBe(3)
  })

  it("tick Bổ sung theo mẫu chuẩn ⇒ free: đích là mẫu FlintFlow", async () => {
    const { seeded, projectId, intent } = await createAndUpload({ has_srs_file: true, complete_to_standard: true }, WRITTEN_SRS)
    expect(intent).toBe("free")
    const preview = (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data.structure_preview
    expect(preview.intent).toBe("free")
    expect([1, 4]).toContain(preview.resolved_mode)
  })

  it("sau finalize: structure_changes ghi lại (mảng, rỗng khi khớp) và GET /import trả kèm", async () => {
    const { seeded, projectId, importId } = await createAndUpload({ has_srs_file: true }, WRITTEN_SRS)
    const doc = (await ImportedDocument.findById(importId))!
    await acceptLatest(doc, true)
    await runExtraction(projectId, seeded.userId, importId)
    await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
    await waitForFinalize(importId)
    const after = (await ImportedDocument.findById(importId))!
    expect(Array.isArray(after.structure_changes)).toBe(true)
    const view = await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))
    expect(view.body.data.import.structure_changes).toEqual(after.structure_changes)
  })
})
