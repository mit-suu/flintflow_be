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
import { stripRecord } from "../../../src/modules/import/check.service.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { importAtBaselining, importAtExtracting } from "../../helpers/mode1-import-p4.js"
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
const toIncomplete = async (intent: "fixed" | "free", startKind: "new" | "existing" = intent === "fixed" ? "new" : "existing") => {
  const ctx = await importAtBaselining({ srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } })
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: intent, start_kind: startKind } })
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
    const { projectId, importId, token, userId } = await toIncomplete("fixed")
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
    expect(downloaded.filename).toContain("DRAFT")
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

  it("dự án mới theo mẫu bắt buộc ⇒ Hoàn thiện bị chặn (409), không khoá mẫu còn trống thành bản gốc", async () => {
    const { projectId, importId, token } = await toIncomplete("fixed")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/finalize`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId), complete: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
    expect((await ImportedDocument.findById(importId))!.status).toBe("incomplete")
    expect((await Project.findById(projectId).lean())!.mode).toBe("import")
  })

  it("dự án có sẵn theo mẫu cố định ⇒ continue 409 (bổ sung mục thiếu qua change request), Hoàn thiện vẫn được", async () => {
    const { projectId, importId, token } = await toIncomplete("fixed", "existing")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: "IMPORT_INVALID_STATE" })
    expect((await Project.findById(projectId).lean())!.mode).toBe("import")
    const done = await request(app)
      .post(`/api/v1/projects/${projectId}/import/finalize`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId), complete: true })
    expect(done.status, JSON.stringify(done.body.error)).toBe(200)
    await waitForFinalize(importId)
    expect((await ImportedDocument.findById(importId))!.status).toBe("gap_review")
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

  it("FLF-378 luồng C: mẫu mục nào cũng có chữ ví dụ ⇒ vẫn chế độ 3, mọi mục 'Sẽ soạn', không 0.1, không bước nào chốt sẵn; continue ⇒ bước sở hữu mục mẫu chờ soạn", async () => {
    const source = await makeDocx({
      styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/></w:style>`,
      body:
        styled("u1", "1 Product Overview") +
        styled("u2", "1.1 Purpose") + p("Ví dụ: Hệ thống quản lý thư viện giúp thủ thư theo dõi sách mượn.") +
        styled("u2", "1.2 Scope") + p("The Library System covers borrowing and returning books for members.") +
        styled("u2", "1.3 Document Conventions") + p("Requirements are written in bold, e.g. FR-001.")
    })
    const { projectId, importId, userId } = await importAtExtracting({ buffer: source })
    await runExtraction(projectId, userId, importId)
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", start_kind: "new" } })
    await startFinalize(projectId, userId, { import_id: importId, base_version: await version(projectId) })
    await waitForFinalize(importId)
    expect((await ImportedDocument.findById(importId))!.status).toBe("incomplete")
    const structure = (await TemplateProfile.findOne({ projectId }).lean())!.target_structure!
    expect(structure.resolved_mode).toBe(3)
    expect(structure.sections.length).toBeGreaterThan(0)
    expect(structure.sections.every((s) => s.status === "missing")).toBe(true)
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    const seeded = (await spineRepository.get(projectId))!
    expect(seeded.steps.filter((s) => s.status === "accepted" && s.id !== "S-8.3").map((s) => s.id)).toEqual([])

    const user = (await User.findById(userId).lean())!
    const project = (await Project.findById(projectId).lean())!
    const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/import/continue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ import_id: importId, base_version: await version(projectId) })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const spine = (await spineRepository.get(projectId))!
    const owners = new Set(structure.sections.flatMap((s) => s.owner_steps.map((id) => id.split("@")[0])))
    expect(owners.size).toBeGreaterThan(0)
    const ownerSteps = spine.steps.filter((s) => owners.has(s.id.split("@")[0]))
    expect(ownerSteps.length).toBeGreaterThan(0)
    expect(ownerSteps.every((s) => s.status === "pending")).toBe(true)
  })
})

