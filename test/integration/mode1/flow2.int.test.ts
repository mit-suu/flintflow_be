/**
 * Chế độ 3 (file giữ khung còn thiếu mục) đi thẳng Luồng 2, Mongo thật: file thiếu cấu trúc đích không có bản gốc 0.1 — finalize
 * tự đưa dự án sang pipeline tạo mới (`mode = fpt`, `import_state = drafting`), B-0 và Brief mở lại từ B-0.1, bước mục thiếu chờ chạy,
 * bước mục khách đã viết giữ chốt; bản in vẫn theo file (không thêm mục ngoài mẫu, mục khách viết in nguyên văn). "Hoàn thiện"
 * từ `incomplete` bị chặn. FLF-416: bổ sung theo mẫu chuẩn (chế độ 4) còn thiếu đi cùng luồng (Luồng 2). Bản ghi cũ còn
 * `incomplete` ⇒ `POST /import/continue`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { projectCode } from "../../../src/modules/project/project-code.js"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { stripRecord } from "../../../src/modules/import/check.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finishReviewIfPending, importAtBaselining, importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { makeDocx, p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { ruleProfileOf } from "../../../src/modules/import/mode1-guard.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { captureTemplateSourceBinding } from "../../../src/modules/doc-version/template-source-binding.js"
import { RenderedDocumentCache } from "../../../src/modules/render/rendered-document.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import { getDocument, listChangesForRecord } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { projectStep } from "../../../src/modules/pipeline/context-projection.js"
import { hasIdea } from "../../../src/modules/pipeline/step-runner.service.js"
import { askableFields } from "../../../src/modules/pipeline/decisions.service.js"
import { parseDocument } from "../../../src/modules/import/parse.service.js"
import { layoutPreviewResponseSchema } from "../../../src/modules/import/import.dto.js"
import { buildTemplateStepContext } from "../../../src/modules/pipeline/template-guidance.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocxPackage } from "../../../src/modules/docx-ooxml/index.js"
import { readZipText } from "../../../src/modules/render/zip.test-helper.js"
import { wAll } from "../../../src/modules/docx-ooxml/xml.js"
import { renderVersionFile } from "../../../src/modules/doc-version/render-version.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { downloadVersion } from "../../../src/modules/doc-version/versions.service.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const version = async (projectId: string) => (await spineRepository.get(projectId))!.spine_version
const toFinalized = async (intent: "fixed" | "free", startKind: "new" | "existing" = intent === "fixed" ? "new" : "existing") => {
  const ctx = await importAtBaselining({ srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } })
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: intent, start_kind: startKind } })
  await startFinalize(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: await version(ctx.projectId) })
  await waitForFinalize(ctx.importId)
  // FLF-453: Product Overview có sẵn ⇒ cần rà trước Luồng 2 (business-flow §3.1.2) — AI giả không phát hiện gì
  await finishReviewIfPending(ctx.projectId, ctx.userId, ctx.importId)
  // Giữ khung còn thiếu (chế độ 3) lẫn bổ sung theo mẫu chuẩn còn thiếu (chế độ 4, FLF-416) ⇒ tự sang Luồng 2
  expect((await ImportedDocument.findById(ctx.importId))!.status).toBe("drafting")
  const user = (await User.findById(ctx.userId).lean())!
  const project = (await Project.findById(ctx.projectId).lean())!
  const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
  return { ...ctx, token }
}

describe("Luồng 2 cho phần thiếu - chế độ 3", () => {
  it("giữ khung còn thiếu ⇒ finalize tự sang Luồng 2: mode fpt + drafting, B-0 + Brief từ B-0.1, không 0.1, chạy step được, bản in theo mẫu", async () => {
    const { projectId, importId, token, userId } = await toFinalized("fixed")
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)

    const project = (await Project.findById(projectId).lean())!
    expect(project).toMatchObject({ mode: "fpt", import_state: "drafting", template_intent: "fixed" })
    expect(project.documentLanguage).toBeTruthy()
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")

    const spine = (await spineRepository.get(projectId))!
    const status = (id: string) => spine.steps.find((s) => s.id === id)?.status
    // FLF-461: B-0 chạy lại (phần đã có làm đầu vào), Brief mở lại; bước kế tiếp là B-0.1
    expect(status("B-0.1")).toBe("pending")
    expect(status("B-1.1")).toBe("pending")
    expect(status("S-1.1")).toBe("pending")
    expect(spine.progress.current_step).toBe("B-0.1")

    // Không còn bị chặn MODE1_NO_STEPS — workspace chạy step như dự án tạo mới
    const steps = await request(app).get(`/api/v1/projects/${projectId}/steps`).set({ Authorization: `Bearer ${token}` })
    expect(steps.status, JSON.stringify(steps.body.error)).toBe(200)
    // FLF-278: rail theo quy trình FlintFlow, mỗi bước kèm heading của mẫu mà bước đó soạn
    const stepList = steps.body.data.steps as { id: string; template_sections?: string[] }[]
    expect(stepList.every((s) => Array.isArray(s.template_sections))).toBe(true)
    const templateHeadings = new Set(((await TemplateProfile.findOne({ projectId }).lean())!.layout ?? []).map((l) => l.heading_text.trim()))
    const tagged = stepList.flatMap((s) => s.template_sections ?? [])
    expect(tagged.length).toBeGreaterThan(0)
    expect(tagged.every((title) => templateHeadings.has(title))).toBe(true)
    expect(stepList.find((s) => s.id === "B-1.1")?.template_sections).toEqual([])

    // Luật cờ: đủ luật tạo mới, chỉ trên mục của mẫu
    const profile = await ruleProfileOf(projectId)
    expect(profile?.templateLayout?.size).toBeGreaterThan(0)
    expect(profile?.exclude.size).toBe(0)

    const layoutIds = new Set(((await TemplateProfile.findOne({ projectId }).lean())!.layout ?? []).map((l) => l.section_id))
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(doc.sections.filter((s) => s.id.startsWith("fixed:") && s.id !== "fixed:I" && !layoutIds.has(s.id))).toEqual([])

    // File tải về phải giữ định dạng Word của upload, kể cả sau khi mode đổi từ import sang fpt.
    const templateProfile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(templateProfile.source_file_ref).toBeTruthy()
    const original = await docFileStore().load(templateProfile.source_file_ref!)
    const exported = await request(app)
      .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
      .set({ Authorization: `Bearer ${token}` })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(exported.status, JSON.stringify(exported.body)).toBe(200)
    expect(readZipText(exported.body as Buffer, "word/styles.xml")).toBe(readZipText(original, "word/styles.xml"))
    const sourcePkg = await DocxPackage.load(original)
    const outputPkg = await DocxPackage.load(exported.body as Buffer)
    const sourceXml = await sourcePkg.requireXml("word/document.xml")
    const outputXml = await outputPkg.requireXml("word/document.xml")
    // Bố cục trang giữ nguyên; khác duy nhất là tham chiếu header chứa watermark DRAFT của bản làm việc
    const layoutOf = (xml: Parameters<typeof wAll>[0]) => wAll(xml, "sectPr").map((e) => e.toString().replace(/<w:headerReference[^>]*\/>/g, ""))
    expect(layoutOf(outputXml)).toEqual(layoutOf(sourceXml))
    expect(readZipText(exported.body as Buffer, "word/document.xml")).not.toContain("WORKING DRAFT - NOT BASELINED")
    const headerXml = (pkg: DocxPackage, data: Buffer) =>
      pkg.partNames().filter((name) => /^word\/header\d+\.xml$/.test(name)).map((name) => readZipText(data, name)).join("")
    expect(headerXml(outputPkg, exported.body as Buffer)).toContain('string="DRAFT"')

    // File version lưu dựng ở baseline (không watermark); lần tải bản chưa phát hành gắn DRAFT, header gốc của mẫu giữ nguyên.
    const templateSource = await captureTemplateSourceBinding(projectId)
    const recordSnapshot = await listChangesForRecord(projectId)
    const versionFile = await renderVersionFile(projectId, "Lumen", spine, { version: "0.1", stampSource: "import", templateSource, recordChanges: recordSnapshot })
    const fileRef = await docFileStore().save(versionFile, { projectId, kind: "version", name: "0.1" })
    await DocVersion.create({ projectId, version: "0.1", kind: "imported", file_ref: fileRef, template_source: templateSource, spine_snapshot: stripRecord(spine), record_snapshot: recordSnapshot, created_by: userId })
    const downloaded = await downloadVersion(projectId, "Lumen", "0.1", "auto", { project })
    expect(downloaded.filename).toBe(`Lumen_${projectCode(projectId)}_v0.1.docx`) // FLF-466: bản nháp nhận ra qua số + watermark (dòng dưới)
    const storedVersion = (await DocVersion.findOne({ projectId, version: "0.1" }).lean())!
    expect(storedVersion.file_ref).toBe(fileRef)
    expect(storedVersion.template_source?.source_file_ref).toBe(templateSource?.source_file_ref)
    expect(storedVersion.record_snapshot).toEqual(recordSnapshot)
    expect(storedVersion.fixed_render_cache?.file_ref).toBeTruthy()
    expect(storedVersion.fixed_render_cache?.file_ref).not.toBe(fileRef)
    expect(headerXml(await DocxPackage.load(versionFile), versionFile)).not.toContain('string="DRAFT"')
    const downloadedPkg = await DocxPackage.load(downloaded.data)
    expect(headerXml(downloadedPkg, downloaded.data)).toContain('string="DRAFT"')
    expect(readZipText(downloaded.data, "word/styles.xml")).toBe(readZipText(original, "word/styles.xml"))
  })

  it("FLF-461: file đã có Product Overview ⇒ B-0 chạy lại nhưng không hỏi lại phần đó; chỉ hỏi nền tảng + mức độ quan trọng file chưa có", async () => {
    const { projectId, userId } = await toFinalized("fixed")
    const spine = (await spineRepository.get(projectId))!
    // B-0 là bước kế tiếp của Luồng 2 (không còn bỏ qua)
    expect(spine.progress.current_step).toBe("B-0.1")
    expect(spine.steps.filter((st) => st.id.startsWith("B-0.")).map((st) => st.status)).toEqual(["pending", "pending", "pending"])
    // Product Overview của file đã vào Spine ⇒ B-0.1 coi là đã có ý tưởng (không hỏi gợi mở), vision không phải field "thiếu"
    expect(spine.project.vision).toBeTruthy()
    expect(hasIdea({ spine, documents: "" })).toBe(true)
    const asked = askableFields("B-0.1", projectStep(spine, "B-0.1").emptyFields)
    expect(asked).not.toContain("project.vision")
    // Phần file chưa có (nền tảng, mức độ quan trọng) mới là thứ hỏi, gộp một lượt ở B-0.1
    expect(asked).toEqual(expect.arrayContaining(["project.form_factor", "project.stakes"]))
    expect(spine.project.form_factor).toEqual([])
    // Phần file đã có (nền tảng, mức độ quan trọng) thì B-0.2 / B-0.3 không còn gì để hỏi (runner bỏ qua, 0 lượt model)
    await applyTransaction(projectId, {
      base_version: spine.spine_version,
      ops: [
        { op: "set", path: "project.form_factor", value: ["web"] },
        { op: "set", path: "project.stakes", value: "internal" }
      ],
      by: userId,
      reason: "test: nền tảng và mức độ quan trọng đã có từ file",
      step_id: null
    })
    const after = (await spineRepository.get(projectId))!
    expect(projectStep(after, "B-0.2").emptyFields).toEqual([])
    expect(projectStep(after, "B-0.3").emptyFields).toEqual([])
    expect(askableFields("B-0.1", projectStep(after, "B-0.1").emptyFields)).not.toEqual(expect.arrayContaining(["project.form_factor"]))
  })

  it("Hoàn thiện (complete: true) từ incomplete bị chặn - không bao giờ khoá file thiếu cấu trúc đích thành bản gốc", async () => {
    const { projectId, importId, token } = await toFinalized("free")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/finalize`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId), complete: true })
    expect(res.status).toBe(409)
    // FLF-416: chế độ 4 đã sang Luồng 2 (dự án `fpt`) — vẫn không có bản gốc 0.1
    expect(res.body.error.code).toBe("PROJECT_MODE_MISMATCH")
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")
    expect((await Project.findById(projectId).lean())!.mode).toBe("fpt")
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
  })

  it("SRS có sẵn viết dở (giữ khung): bước của mục khách đã viết giữ chốt, chỉ bước mục thiếu chờ soạn; bản in giữ nguyên văn mục đã viết, mục vừa soạn in nội dung mới", async () => {
    const { projectId, token } = await toFinalized("fixed", "existing")
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const structure = profile.target_structure!
    expect(structure.resolved_mode).toBe(3)
    expect(profile.structure_preview?.summary.kind).toBe("written")
    expect(profile.flow2_entry_at).toBeTruthy()
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    // Workspace (mode fpt) vẫn đọc được lần import để báo mục lệch bản sơ bộ
    const view = await request(app).get(`/api/v1/projects/${projectId}/import`).set({ Authorization: `Bearer ${token}` })
    expect(view.status, JSON.stringify(view.body.error)).toBe(200)
    expect(view.body.data.import).toMatchObject({ status: "drafting" })
    expect(Array.isArray(view.body.data.import.structure_changes)).toBe(true)
    const spine = (await spineRepository.get(projectId))!
    const statusOf = (id: string) => spine.steps.filter((st) => st.id === id || st.id.startsWith(`${id}@`)).map((st) => st.status)
    const present = structure.sections.filter((sec) => sec.status === "present")
    const missing = structure.sections.filter((sec) => sec.status === "missing")
    expect(present.length).toBeGreaterThan(0)
    expect(missing.length).toBeGreaterThan(0)
    // Mục khách đã viết: không bước sở hữu nào chờ chạy (đã chốt, kể cả bước lúc import chưa trích được dữ liệu; hoặc bỏ qua) —
    // trừ bước soạn mục riêng (FLF-382: S-8.1 còn mục riêng trống thì vẫn soạn, chỉ ghi được mục còn trống)
    const customGap = missing.some((sec) => sec.section_id.startsWith("custom:"))
    for (const sec of present) for (const owner of sec.owner_steps.filter((o) => !(customGap && o === "S-8.1"))) expect(statusOf(owner).includes("pending"), `${sec.section_id} ⇐ ${owner}`).toBe(false)
    if (customGap) {
      expect(statusOf("S-8.1")).toEqual(["pending"])
      // Ngữ cảnh mẫu chỉ có mục còn thiếu; prompt S-8.1 chỉ cho ghi đúng mục riêng còn trống
      const missingIds = new Set(missing.map((sec) => sec.section_id))
      expect(profile.template_context?.length).toBeGreaterThan(0)
      expect(profile.template_context!.every((c) => missingIds.has(c.section_id))).toBe(true)
      const ctx = buildTemplateStepContext(profile.template_context, "S-8.1", spine)
      const writtenCustom = new Set(present.filter((sec) => sec.section_id.startsWith("custom:")).map((sec) => sec.section_id.slice("custom:".length)))
      expect(ctx.customSections.length).toBeGreaterThan(0)
      expect(ctx.customSections.every((c) => missingIds.has(`custom:${c.id}`) && !writtenCustom.has(c.id))).toBe(true)
      expect(ctx.guidance).toContain("already written by the customer")
    }
    expect(statusOf("S-3.6")).toEqual(["accepted"])
    // Bước chỉ sở hữu mục thiếu: chờ soạn hoặc giữ nguyên bỏ qua — không bao giờ đã chốt sẵn
    const keep = new Set(present.flatMap((sec) => sec.owner_steps))
    for (const sec of missing) for (const owner of sec.owner_steps.filter((o) => !keep.has(o))) expect(statusOf(owner).includes("accepted")).toBe(false)

    const exportDraft = async (): Promise<string[]> => {
      const res = await request(app)
        .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
        .set({ Authorization: `Bearer ${token}` })
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = []
          r.on("data", (c: Buffer) => chunks.push(c))
          r.on("end", () => cb(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      const xml = await (await DocxPackage.load(res.body as Buffer)).requireXml("word/document.xml")
      return wAll(xml, "p").map((para) => wAll(para, "t").map((t) => t.textContent ?? "").join("")).filter((t) => t.trim())
    }
    const sourceXml = await (await DocxPackage.load(await docFileStore().load(profile.source_file_ref!))).requireXml("word/document.xml")
    const original = wAll(sourceXml, "p").map((para) => wAll(para, "t").map((t) => t.textContent ?? "").join("")).filter((t) => t.trim())
    const before = await exportDraft()
    // Chưa soạn gì: chữ khách viết in nguyên văn (không dựng lại từ Spine)
    for (const line of original.filter((t) => !t.startsWith("[") && t.length > 30)) expect(before, line).toContain(line)

    // Soạn mục còn thiếu (mục riêng của file) ⇒ bản in có nội dung mới, mục khách viết vẫn nguyên văn
    const gap = missing.find((sec) => sec.section_id.startsWith("custom:"))!
    const section = (await spineRepository.get(projectId))!.custom_sections.find((c) => `custom:${c.id}` === gap.section_id)!
    await applyTransaction(projectId, {
      base_version: await version(projectId),
      by: "test",
      reason: "Draft the missing section",
      step_id: null,
      ops: [
        { op: "remove", path: `custom_sections[id=${section.id}]` },
        { op: "add", path: "custom_sections[]", value: { ...section, blocks: [{ kind: "paragraph", text: "Requirements use the shall keyword and carry an FR code.", rows: null, image_ref: null }] } }
      ]
    })
    const after = await exportDraft()
    expect(after.join("\n")).toContain("Requirements use the shall keyword and carry an FR code.")
    for (const line of original.filter((t) => !t.startsWith("[") && t.length > 30)) expect(after, line).toContain(line)
  })

  /** Dữ liệu do bản trước tạo: I-5 ra chế độ 3 / 4 nhưng chưa tự chuyển — dự án còn `import`, lần import dừng `incomplete`. */
  const asLegacyIncomplete = async (projectId: string, importId: string) => {
    await Project.updateOne({ _id: projectId }, { $set: { mode: "import", import_state: "incomplete" } })
    await ImportedDocument.updateOne({ _id: importId }, { $set: { status: "incomplete" } })
    await TemplateProfile.updateOne({ projectId }, { $set: { flow2_entry_at: null, flow2_entry_spine: null } })
  }

  it("bản ghi cũ chế độ 3 còn dừng ở incomplete ⇒ POST /import/continue sang Luồng 2", async () => {
    const { projectId, importId, token } = await toFinalized("free")
    await asLegacyIncomplete(projectId, importId)
    // Giữ khung, I-5 cũ ra chế độ 3
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed" } })
    await TemplateProfile.updateOne({ projectId }, { $set: { "target_structure.resolved_mode": 3, "target_structure.intent": "fixed", structure_preview: null } })
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ project_mode: "fpt", import_state: "drafting", current_step: "B-0.1" })
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")
  })

  it("FLF-416 bản ghi cũ chế độ 4 còn dừng ở incomplete ⇒ POST /import/continue sang Luồng 2 (trước đây 409)", async () => {
    const { projectId, importId, token } = await toFinalized("free")
    await asLegacyIncomplete(projectId, importId)
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ project_mode: "fpt", import_state: "drafting", current_step: "B-0.1" })
    expect((await TemplateProfile.findOne({ projectId }).lean())!.flow2_entry_at).toBeTruthy()
  })

  it("FLF-416 tick bổ sung theo mẫu chuẩn (chế độ 4) còn thiếu ⇒ finalize tự sang Luồng 2 như chế độ 3: mode fpt + drafting, B-0 + Brief từ B-0.1, bước mục thiếu chờ soạn, bước mục đã viết giữ chốt, có Spine mốc", async () => {
    const { projectId, importId, token } = await toFinalized("free")
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const structure = profile.target_structure!
    expect(structure.resolved_mode).toBe(4)
    expect(profile.flow2_entry_at).toBeTruthy()
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect((await Project.findById(projectId).lean())!).toMatchObject({ mode: "fpt", import_state: "drafting", template_intent: "free" })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.progress.current_step).toBe("B-0.1")
    const statusOf = (id: string) => spine.steps.filter((st) => st.id === id || st.id.startsWith(`${id}@`)).map((st) => st.status)
    // FLF-463: heading riêng của file là mục của đích ⇒ mục riêng còn trống giữ bước soạn mục riêng mở (FLF-382: chỉ ghi đúng mục trống)
    const missingOwners = new Set(structure.sections.filter((sec) => sec.status === "missing").flatMap((sec) => sec.owner_steps))
    const keep = new Set(structure.sections.filter((sec) => sec.status === "present").flatMap((sec) => sec.owner_steps).filter((o) => !missingOwners.has(o)))
    for (const owner of keep) expect(statusOf(owner).includes("pending"), owner).toBe(false)
    const draft = [...new Set(structure.sections.filter((sec) => sec.status === "missing").flatMap((sec) => sec.owner_steps))].filter((o) => !keep.has(o))
    expect(draft.length).toBeGreaterThan(0)
    for (const owner of draft) expect(statusOf(owner), owner).toContain("pending")
    // Đã ở Luồng 2 (dự án `fpt`) ⇒ gọi tiếp lần nữa bị chặn (không mở lại lần hai)
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PROJECT_MODE_MISMATCH")
  })
  it("exports source Purpose and Scope after repairing legacy layout and bypassing incorrect cached headings", async () => {
    const source = await makeDocx({
      styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/></w:style>`,
      body: styled("u1", "1 Product Overview") + styled("u2", "1.1 Purpose") + p("[Describe the purpose.]") + styled("u2", "1.2 Scope") + p("[Describe the scope.]") + styled("u2", "1.3 Document Conventions") + p("[Describe the conventions.]")
    })
    const { projectId, importId, userId } = await importAtExtracting({ buffer: source })
    await runExtraction(projectId, userId, importId)
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", start_kind: "new" } })
    await startFinalize(projectId, userId, { import_id: importId, base_version: await version(projectId) })
    await waitForFinalize(importId)
    await finishReviewIfPending(projectId, userId, importId)
    const user = (await User.findById(userId).lean())!
    const project = (await Project.findById(projectId).lean())!
    const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
    await applyTransaction(projectId, {
      base_version: await version(projectId), by: userId, reason: "Complete source slots", step_id: null,
      ops: [
        { op: "set", path: "project.vision", value: "Purpose populated from the current Spine." },
        { op: "set", path: "project.release_scope", value: { in: ["Scope populated from the current Spine."], out: [] } }
      ]
    })
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.source_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(profile.heading_map.some((h) => h.heading_text.includes("Purpose"))).toBe(true)
    const legacyLayout = profile.layout.filter((entry) => !/Purpose|Scope/.test(entry.heading_text))
    await TemplateProfile.updateOne({ projectId }, { $set: { layout: legacyLayout } })

    const cached = await getDocument(projectId, "Lumen", { source: "draft" })
    const wrong = { ...cached, sections: cached.sections.map((section) => ({ ...section, title: "Incorrect cached heading", blocks: [{ type: "paragraph", runs: [{ text: "STALE CACHE CONTENT" }] }] })) }
    await RenderedDocumentCache.updateOne({ projectId, spine_version: await version(projectId) }, { $set: {
      assembled_at_version: await version(projectId), generated_at: new Date(), doc: wrong
    } }, { upsert: true })

    const exported = await request(app).get(`/api/v1/projects/${projectId}/export/word?source=draft`)
      .set({ Authorization: `Bearer ${token}` }).buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(exported.status, JSON.stringify(exported.body)).toBe(200)
    const xml = await (await DocxPackage.load(exported.body as Buffer)).requireXml("word/document.xml")
    const paragraphs = wAll(xml, "p").map((paragraph) => paragraph.textContent ?? "")
    const purpose = paragraphs.indexOf("1.1 Purpose")
    const scope = paragraphs.indexOf("1.2 Scope")
    expect(purpose).toBeGreaterThan(-1)
    expect(scope).toBeGreaterThan(purpose)
    expect(paragraphs.slice(purpose + 1, scope).join(" ")).toContain("Purpose populated from the current Spine.")
    expect(paragraphs.slice(scope + 1).join(" ")).toContain("Scope populated from the current Spine.")
    expect(paragraphs.join(" ")).not.toMatch(/Incorrect cached heading|STALE CACHE CONTENT|\[Describe the (purpose|scope)\.\]/)
    expect(readZipText(exported.body as Buffer, "word/styles.xml"))
      .toBe(readZipText(source, "word/styles.xml"))
  })

  it("FLF-463 (đảo FLF-378 luồng C): khung mẫu giữ khung có mục đã viết (kể cả chữ ví dụ) ⇒ mục đó là có, được đọc, không soạn lại; chỉ soạn mục còn trống, không 0.1", async () => {
    const source = await makeDocx({
      styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/></w:style>`,
      body:
        styled("u1", "1 Product Overview") +
        styled("u2", "1.1 Purpose") + p("Ví dụ: Hệ thống quản lý thư viện giúp thủ thư theo dõi sách mượn.") +
        styled("u2", "1.2 Scope") + p("The Library System covers borrowing and returning books for members.") +
        styled("u2", "1.3 Document Conventions") + p("[Describe the conventions.]")
    })
    const { projectId, importId, userId } = await importAtExtracting({ buffer: source })
    await runExtraction(projectId, userId, importId)
    // Hồ sơ trước màn đọc khung (không có bản sơ bộ), dự án mới có mẫu bắt buộc: nhãn khung mẫu không làm mục đã viết thành thiếu
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", start_kind: "new" } })
    await TemplateProfile.updateOne({ projectId }, { $set: { structure_preview: null } })
    await startFinalize(projectId, userId, { import_id: importId, base_version: await version(projectId) })
    await waitForFinalize(importId)
    await finishReviewIfPending(projectId, userId, importId)
    expect((await ImportedDocument.findById(importId))!.status).toBe("drafting")
    const structure = (await TemplateProfile.findOne({ projectId }).lean())!.target_structure!
    expect(structure.resolved_mode).toBe(3)
    expect(structure.sections.find((s) => s.section_id === "fixed:1")?.status).toBe("present")
    const conventions = structure.sections.find((s) => s.title.includes("Document Conventions"))!
    expect(conventions.status).toBe("missing")
    expect(structure.missing).toEqual([conventions.section_id])
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    // Ngữ cảnh mẫu chỉ cho mục còn trống — mục đã viết không bị soạn lại
    const context = (await TemplateProfile.findOne({ projectId }).lean())!.template_context!
    expect(context.map((c) => c.section_id)).toEqual([conventions.section_id])
    expect(context[0]!.guidance).toEqual(["Describe the conventions."])
    // Có mục đã viết ⇒ như SRS viết dở: lưu Spine mốc để bản in giữ nguyên văn mục chưa đổi
    expect((await TemplateProfile.findOne({ projectId }).lean())!.flow2_entry_at).toBeTruthy()
    const spine = (await spineRepository.get(projectId))!
    const statusOf = (id: string) => spine.steps.filter((st) => st.id === id || st.id.startsWith(`${id}@`)).map((st) => st.status)
    for (const owner of conventions.owner_steps) expect(statusOf(owner.split("@")[0]), owner).toContain("pending")
    const kept = structure.sections.find((s) => s.section_id === "fixed:1")!.owner_steps.filter((o) => !conventions.owner_steps.includes(o))
    for (const owner of kept) expect(statusOf(owner).includes("pending"), owner).toBe(false)
  })
})


describe("FLF-461 bước 2.9a - chế độ 4 xem trước bố cục, xác nhận rồi mới áp", () => {
  const exportDraft = async (projectId: string, token: string) => {
    const res = await request(app)
      .get(`/api/v1/projects/${projectId}/export/word?source=draft`)
      .set({ Authorization: `Bearer ${token}` })
      .buffer(true)
      .parse((r, callback) => {
        const chunks: Buffer[] = []
        r.on("data", (chunk: Buffer) => chunks.push(chunk))
        r.on("end", () => callback(null, Buffer.concat(chunks)))
      })
    expect(res.status, String(res.body)).toBe(200)
    return (await parseDocument(res.body as Buffer)).blocks.filter((b) => b.kind === "heading").map((b) => b.text)
  }

  it("chưa xác nhận ⇒ bản in giữ bố cục file (mục Ngoài phạm vi chưa xuống cuối); xác nhận xong mới áp, mục Ngoài phạm vi xuống cuối", async () => {
    const { projectId, token } = await toFinalized("free")
    const base = `/api/v1/projects/${projectId}/import/layout-preview`
    const auth = { Authorization: `Bearer ${token}` }

    // Mục đầu của file được coi là Ngoài phạm vi: giữ nguyên nội dung, chỉ đổi vị trí
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const first = [...profile.layout].sort((a, b) => a.order - b.order).find((l) => l.level === 1 && !l.section_id.startsWith("group:") && l.heading_text.trim())!
    await TemplateProfile.updateOne(
      { projectId, "target_structure.sections.section_id": first.section_id },
      { $set: { "target_structure.sections.$.status": "out_of_scope", "target_structure.sections.$.owner_steps": [] } }
    )

    const before = await exportDraft(projectId, token)
    const at = (headings: string[]) => headings.findIndex((h) => h.includes(first.heading_text.trim()))
    expect(at(before)).toBeGreaterThanOrEqual(0)
    expect(at(before)).toBeLessThan(before.length - 1)

    // Xem trước: có bố cục mới nhưng chưa xác nhận
    const preview = layoutPreviewResponseSchema.parse((await request(app).get(base).set(auth)).body.data)
    expect(preview).toMatchObject({ applicable: true, confirmed_at: null })
    expect(preview.sections.filter((s) => s.origin === "out_of_scope").map((s) => s.section_id)).toContain(first.section_id)
    expect(preview.sections.at(-1)?.origin).toBe("out_of_scope")
    // Xem trước không áp: bản in vẫn như trước
    expect(await exportDraft(projectId, token)).toEqual(before)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.layout_confirmed_at ?? null).toBeNull()

    // Người xác nhận ⇒ từ giờ áp bố cục mới
    const confirmed = layoutPreviewResponseSchema.parse((await request(app).post(`${base}/confirm`).set(auth)).body.data)
    expect(confirmed.confirmed_at).not.toBeNull()
    const after = await exportDraft(projectId, token)
    expect(at(after)).toBeGreaterThan(at(before))
    expect(after.slice(at(after)).filter((h) => !h.includes(first.heading_text.trim())).length).toBeLessThan(after.length - at(after))
    // Gọi lại xác nhận không đổi mốc
    const again = layoutPreviewResponseSchema.parse((await request(app).post(`${base}/confirm`).set(auth)).body.data)
    expect(again.confirmed_at).toBe(confirmed.confirmed_at)
  })

  it("chế độ 3 không có bước xem trước bố cục (giữ đúng thứ tự mẫu): applicable false, xác nhận bị chặn", async () => {
    const { projectId, token } = await toFinalized("fixed")
    const base = `/api/v1/projects/${projectId}/import/layout-preview`
    const auth = { Authorization: `Bearer ${token}` }
    expect((await request(app).get(base).set(auth)).body.data).toMatchObject({ applicable: false, sections: [] })
    const res = await request(app).post(`${base}/confirm`).set(auth)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
  })
})
