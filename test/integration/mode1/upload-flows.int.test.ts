/**
 * FLF-411 — ba luồng upload SRS (hộp Tạo dự án), chạy trọn upload ⇒ màn đọc khung ⇒ đọc nội dung ⇒ finalize trên file thật:
 *
 * 1. Up **template trống** (giữ khung) ⇒ khung mẫu: không trích chữ / hình mẫu, soạn đủ mọi mục (luồng C), không dữ liệu ví dụ.
 * 2. Up **SRS có sẵn, không tick** "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow" ⇒ giữ đúng khung file (chế độ 1 khi đủ mục).
 * 3. Up **SRS có sẵn, tick** ⇒ đích là mẫu FlintFlow (bổ sung mục thiếu). FLF-416: còn thiếu ⇒ chế độ 4 vào Luồng 2 như chế độ 3
 *    (bước của mục thiếu chờ soạn, bước của mục khách đã viết giữ chốt).
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
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { readZipText } from "../../../src/modules/render/zip.test-helper.js"
import { parseDocument } from "../../../src/modules/import/parse.service.js"
import { snapshotBaseline } from "../../../src/modules/pipeline/s9/baseline.service.js"
import { convertFromFpt } from "../../../src/modules/import/convert-from-fpt.service.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const REPORT3_TEMPLATE = new URL("../../../fixtures/fpt-report3-blank-template.docx", import.meta.url)
const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const TECHMART_SRS = new URL("../../../fixtures/techmart-srs-fpt.docx", import.meta.url)

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
  const view = (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data
  const preview = view.structure_preview
  const estimate = view.credit_estimate
  const doc = (await ImportedDocument.findById(importId))!
  await acceptLatest(doc, true)
  await runExtraction(projectId, seeded.userId, importId)
  const usageAfterRead = await Usage.countDocuments({ projectId })
  await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
  await waitForFinalize(importId)
  const project = (await Project.findById(projectId).lean())!
  const spine = (await spineRepository.get(projectId))!
  const profile = (await TemplateProfile.findOne({ projectId }).lean())!
  return { seeded, projectId, preview, estimate, usageAfterRead, project, spine, profile, status: (await ImportedDocument.findById(importId))!.status }
}

describe("FLF-411 - ba luồng upload", () => {
  it("1. up template trống (giữ khung) ⇒ khung mẫu, không đọc nội dung bằng AI, Spine không có dữ liệu ví dụ, soạn đủ từ đầu", async () => {
    const r = await uploadAndFinalize(REPORT3_TEMPLATE, false)
    expect(r.preview.summary).toMatchObject({ kind: "template", present: 0 })
    expect(r.preview.intent).toBe("fixed")
    // Không gọi AI đọc chữ / hình mẫu; FLF-411 (U1-8): màn đọc khung không báo credit (không đọc, không kiểm tra AI)
    expect(r.usageAfterRead).toBe(0)
    expect(r.estimate).toMatchObject({ ai_calls: 0, credits: 0 })
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

  it("3b. FLF-416 - TechMart (thiếu Glossary) + tick ⇒ chế độ 4 vào Luồng 2: soạn bước mục thiếu, giữ chốt mục khách đã viết", async () => {
    const r = await uploadAndFinalize(TECHMART_SRS, true)
    expect(r.preview.intent).toBe("free")
    expect(r.preview.summary.kind).toBe("written")
    const structure = r.profile.target_structure!
    expect(structure.resolved_mode).toBe(4)
    const missing = structure.sections.filter((s) => s.status === "missing")
    const present = structure.sections.filter((s) => s.status === "present")
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.some((s) => /glossary|thuật ngữ/i.test(s.title))).toBe(true)
    // Luồng 2 như chế độ 3: mode fpt, import đang soạn, có Spine mốc cho bản in theo file khách
    expect(r.status).toBe("drafting")
    expect(r.project).toMatchObject({ mode: "fpt", import_state: "drafting", template_intent: "free" })
    expect(r.profile.flow2_entry_at).toBeTruthy()
    expect(r.profile.flow2_entry_spine).toBeTruthy()
    const statusOf = (id: string) => r.spine.steps.filter((st) => st.id === id || st.id.startsWith(`${id}@`)).map((st) => st.status)
    const keepOwners = new Set(present.flatMap((s) => s.owner_steps))
    // Bước sở hữu mục thiếu (không trùng bước giữ chốt) chờ soạn
    const draftOwners = [...new Set(missing.flatMap((s) => s.owner_steps))].filter((o) => !keepOwners.has(o))
    expect(draftOwners.length).toBeGreaterThan(0)
    for (const owner of draftOwners) expect(statusOf(owner), owner).toContain("pending")
    // Bước sở hữu mục khách đã viết giữ chốt
    for (const owner of keepOwners) expect(statusOf(owner).includes("pending"), owner).toBe(false)
    // Brief mở lại (2.4): B-1.1 chờ chạy, B-0 bỏ qua
    expect(r.spine.steps.find((st) => st.id === "B-1.1")?.status).toBe("pending")
    expect(r.spine.progress.current_step).toBe("B-1.1")

    // Bản in (2.10): file khách là nền (giữ style), Glossary soạn thêm chèn thành heading mới đúng vị trí mẫu chuẩn
    const term = "Checkout Basket FLF416"
    await applyTransaction(r.projectId, {
      base_version: r.spine.spine_version, by: r.seeded.userId, reason: "Draft glossary", step_id: null,
      ops: [{ op: "add", path: "glossary[]", value: { id: "G-416", term, definition: "Giỏ hàng lúc thanh toán." } }]
    })
    const original = await docFileStore().load(r.profile.source_file_ref!)
    const exported = await request(app)
      .get(`/api/v1/projects/${r.projectId}/export/word?source=draft`)
      .set(H(r.seeded))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(exported.status, String(exported.body)).toBe(200)
    expect(readZipText(exported.body as Buffer, "word/styles.xml")).toBe(readZipText(original, "word/styles.xml"))
    const printed = (await parseDocument(exported.body as Buffer)).blocks
    const glossaryAt = printed.findIndex((b) => b.kind === "heading" && /glossary|thuật ngữ/i.test(b.text))
    expect(glossaryAt).toBeGreaterThan(0)
    expect(printed.slice(glossaryAt).some((b) => JSON.stringify(b.rows ?? b.text).includes(term))).toBe(true)
    // Mục khách đã viết vẫn in nguyên văn: heading của file giữ nguyên thứ tự
    const sourceHeadings = (await parseDocument(original)).blocks.filter((b) => b.kind === "heading").map((b) => b.text)
    const printedHeadings = printed.filter((b) => b.kind === "heading").map((b) => b.text)
    expect(printedHeadings.filter((t) => sourceHeadings.includes(t))).toEqual(sourceHeadings)

    // BF §1: chốt baseline 1.0 ⇒ quy về C-* — dự án chuyển sang sửa bằng CR, bản 1.0 vẫn là file của khách
    const { projectId: _id, ...current } = (await spineRepository.get(r.projectId))!
    await snapshotBaseline(r.projectId, current, { base_version: current.spine_version, version: "1.0", type: "generated", doc_version: null, by: r.seeded.userId, step_id: null })
    expect(await convertFromFpt(r.projectId, r.seeded.userId, { quiet: true })).toMatchObject({ doc_version: "1.0" })
    expect((await Project.findById(r.projectId).lean())!).toMatchObject({ mode: "import", import_state: "delivered", converted_from: "fpt", template_intent: "free" })
    const v1 = (await DocVersion.findOne({ projectId: r.projectId, version: "1.0" }).lean())!
    const v1File = await docFileStore().load(v1.file_ref)
    expect(readZipText(v1File, "word/styles.xml")).toBe(readZipText(original, "word/styles.xml"))
    expect(readZipText(v1File, "word/document.xml")).toContain(term)
    expect(await ImportedDocument.countDocuments({ projectId: r.projectId, status: "drafting" })).toBe(0)
    // Bản nháp sau 1.0 (luồng CR) vẫn in trên file của khách
    const afterExport = await request(app)
      .get(`/api/v1/projects/${r.projectId}/export/word?source=draft`)
      .set(H(r.seeded))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(afterExport.status, String(afterExport.body)).toBe(200)
    expect(readZipText(afterExport.body as Buffer, "word/styles.xml")).toBe(readZipText(original, "word/styles.xml"))
    expect(readZipText(afterExport.body as Buffer, "word/document.xml")).toContain(term)
  }, 180000)

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
