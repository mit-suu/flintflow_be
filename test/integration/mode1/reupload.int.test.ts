/**
 * Re-upload sau baseline (nút 1.4, UC-24) ở tầng service trên Mongo thật — plan §8.2 `reupload.test.ts`. FLF-172 P4.
 * Thêm/xoá/sửa/di chuyển block; không tạo version; stamp project khác bị từ chối.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { projectCode } from "../../../src/modules/project/project-code.js"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fileOf, importAtBaselining, importAtExtracting, importFinalized } from "../../helpers/mode1-import-p4.js"
import { reupload, toReuploadDto } from "../../../src/modules/import/reupload.service.js"
import { ReuploadDiff } from "../../../src/modules/import/reupload-diff.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocxPackage, readStamp, writeStamp } from "../../../src/modules/docx-ooxml/index.js"
import { downloadVersion } from "../../../src/modules/doc-version/versions.service.js"
import { makeDocx, p } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { SRS_FIXTURE_TEXT, makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import mongoose from "mongoose"
import request from "supertest"
import app from "../../../src/app.js"
import { authAs, seedFixture } from "../../setup.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { addComment } from "../../../src/modules/docx-ooxml/index.js"
import { styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { uploadImport } from "../../../src/modules/import/import.service.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { renderExportDocx } from "../../../src/modules/render/export.controller.js"
import { contextOf } from "../../../src/modules/render/render.controller.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const paraText = (el: Element) =>
  Array.from(el.getElementsByTagNameNS(W, "t"))
    .map((t) => t.textContent ?? "")
    .join("")
const para = (doc: Document, text: string): Element => {
  const hit = Array.from(doc.getElementsByTagNameNS(W, "p")).find((x) => paraText(x) === text)
  if (!hit) throw new Error(`Không thấy đoạn "${text}"`)
  return hit
}
const setText = (el: Element, text: string) => {
  const ts = Array.from(el.getElementsByTagNameNS(W, "t"))
  ts[0].textContent = text
  for (const t of ts.slice(1)) t.parentNode?.removeChild(t)
}
const newPara = (doc: Document, text: string) => {
  const el = doc.createElementNS(W, "w:p")
  const r = doc.createElementNS(W, "w:r")
  const t = doc.createElementNS(W, "w:t")
  t.textContent = text
  r.appendChild(t)
  el.appendChild(r)
  return el
}

/** Tải file version 0.1 (bản render từ Spine + stamp — FLF-186), sửa như người dùng sửa trong Word. */
const editVersion = async (projectId: string, fn: (doc: Document) => void) => {
  const v = (await DocVersion.findOne({ projectId, version: "0.1" }).lean())!
  const pkg = await DocxPackage.load(await docFileStore().load(v.file_ref))
  fn(await pkg.requireXml("word/document.xml"))
  return { pkg, buffer: await pkg.toBuffer() }
}

/** Đoạn nằm trong content control mục lục (FLF-344: file version ghi sẵn dòng mục lục trùng chữ heading). */
const inToc = (p: Element): boolean => {
  for (let n = p.parentNode; n; n = n.parentNode) if ((n as Element).localName === "sdt") return true
  return false
}

const paraEndingWith = (doc: Document, suffix: string): Element => {
  const hit = Array.from(doc.getElementsByTagNameNS(W, "p")).find((x) => !inToc(x) && paraText(x).endsWith(suffix))
  if (!hit) throw new Error(`Không thấy đoạn kết thúc bằng "${suffix}"`)
  return hit
}

const snapshotCounts = async (projectId: string) => ({
  versions: await DocVersion.countDocuments({ projectId }),
  blocks: await DocBlock.countDocuments({ projectId }),
  spine: (await spineRepository.get(projectId))!.spine_version
})

describe("re-upload - diff theo block", () => {
  it("so với bản render 0.1 (FLF-186): thêm + xoá + sửa + di chuyển ⇒ đúng từng loại (khớp theo text); không tạo version, không đổi Spine/block", async () => {
    const { projectId, userId, importId } = await importFinalized()
    const before = await snapshotCounts(projectId)
    const EDITED = "Lumen is an online learning platform for large training centers."
    const NOTES = "Internal notes that do not belong to the template."
    let moved = ""

    const { buffer } = await editVersion(projectId, (doc) => {
      const purpose = para(doc, SRS_FIXTURE_TEXT.purpose)
      setText(purpose, EDITED)
      const del = para(doc, NOTES)
      del.parentNode!.removeChild(del)
      const heading = paraEndingWith(doc, "Team Notes")
      moved = paraText(heading)
      heading.parentNode!.removeChild(heading)
      purpose.parentNode!.insertBefore(heading, purpose.nextSibling)
      heading.parentNode!.insertBefore(newPara(doc, "Added after baseline."), heading.nextSibling)
    })
    const diff = await reupload(projectId, userId, fileOf(buffer, "SRS_Lumen_v2.docx"))
    const dto = toReuploadDto(diff)
    expect(dto).toMatchObject({ original_name: "SRS_Lumen_v2.docx", against_version: "0.1", summary: { added: 1, removed: 1, modified: 1, moved: 1 } })
    expect(dto.blocks).toEqual(
      expect.arrayContaining([
        // FLF-447: entry mang thêm mục chứa nó (`section`) + loại (`kind`)
        expect.objectContaining({ block_id: null, change: "modified", before: SRS_FIXTURE_TEXT.purpose, after: EDITED, kind: "paragraph" }),
        expect.objectContaining({ block_id: null, change: "removed", before: NOTES }),
        expect.objectContaining({ block_id: null, change: "moved", before: moved, after: moved, kind: "heading" }),
        expect.objectContaining({ block_id: null, change: "added", after: "Added after baseline." })
      ])
    )

    // lưu diff + file re-upload, KHÔNG tạo version / block / change Spine, import giữ trạng thái
    expect(await snapshotCounts(projectId)).toEqual(before)
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(1)
    expect((await docFileStore().load(diff.file_ref!)).equals(buffer)).toBe(true)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("gap_review")
  })

  it("upload lại đúng file version ⇒ diff rỗng; upload hai lần ⇒ hai bản diff, vẫn một version", async () => {
    const { projectId, userId } = await importFinalized()
    const { buffer } = await editVersion(projectId, () => undefined)
    const a = toReuploadDto(await reupload(projectId, userId, fileOf(buffer)))
    expect(a.summary).toEqual({ added: 0, removed: 0, modified: 0, moved: 0 })
    await reupload(projectId, userId, fileOf(buffer))
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(2)
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })

  it("FLF-334: bản nháp vừa tải về (stamp mới + DRAFT) sửa trong Word rồi upload lại ⇒ nhận ra, có diff", async () => {
    const { projectId, userId } = await importFinalized()
    const dl = await downloadVersion(projectId, "Lumen", "0.1", "auto")
    expect(dl.filename).toBe(`Lumen_${projectCode(projectId)}_v0.1.docx`) // FLF-466: mã dự án + số bản
    const pkg = await DocxPackage.load(dl.data)
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId, version: "0.1", base_version: "0.1", kind: "draft", project_code: projectCode(projectId) })
    setText(para(await pkg.requireXml("word/document.xml"), SRS_FIXTURE_TEXT.purpose), `${SRS_FIXTURE_TEXT.purpose} Edited in Word.`)
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer(), dl.filename)))
    expect(dto).toMatchObject({ against_version: "0.1", summary: { added: 0, removed: 0, modified: 1, moved: 0 } })
  })

})

describe("re-upload - từ chối", () => {
  it("stamp của project khác ⇒ IMPORT_STAMP_FOREIGN_PROJECT, không lưu diff/file", async () => {
    const { projectId, userId } = await importFinalized()
    const { pkg } = await editVersion(projectId, () => undefined)
    await writeStamp(pkg, { project_id: "66f0000000000000000000ff", version: "0.4", source: "cr_revision" })
    await expect(reupload(projectId, userId, fileOf(await pkg.toBuffer()))).rejects.toMatchObject({
      code: "IMPORT_STAMP_FOREIGN_PROJECT",
      meta: { stamp: { project_id: "66f0000000000000000000ff" } }
    })
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(0)
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })

  it("file không dấu version, heading khớp ⇒ so theo nội dung với bản nháp hiện tại, `no_stamp`, không gợi ý tham khảo (FLF-457, trước đây IMPORT_REUPLOAD_NO_STAMP)", async () => {
    const { projectId, userId } = await importFinalized()
    const pkg = await DocxPackage.load(await makeSrsDocx())
    const doc = await pkg.requireXml("word/document.xml")
    const extra = para(doc, SRS_FIXTURE_TEXT.purpose)
    extra.parentNode!.insertBefore(newPara(doc, "Brand new paragraph."), extra.nextSibling)
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer())))
    expect(dto).toMatchObject({ against_version: "0.1", no_stamp: true, suggest_reference: false, before_baseline: false })
    expect(dto.heading_match).toBeGreaterThanOrEqual(0.5)
    expect(dto.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ change: "added", after: "Brand new paragraph." })]))
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })

  it("FLF-457: Track Changes / comment của người ngoài ⇒ nhận (trước đây IMPORT_FILE_REJECTED) (không từ chối), mỗi chỗ một dòng markup; lần import đầu vẫn từ chối", async () => {
    const { projectId, userId } = await importFinalized()
    const { pkg } = await editVersion(projectId, () => undefined)
    await addForeignMarkup(pkg, SRS_FIXTURE_TEXT.purpose)
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer())))
    expect(dto.markup).toEqual([
      expect.objectContaining({ kind: "track_change", author: "Lan", change: "text", text: " Customer note.", location: expect.objectContaining({ text: expect.stringContaining("Lumen") }) }),
      expect.objectContaining({ kind: "comment", author: "Khách hàng", text: "Please confirm the scope." })
    ])
    expect(dto.markup[0].section).not.toBe("")
    // chữ chèn bằng Track Changes cũng hiện trong khác biệt theo block
    expect(dto.summary.modified).toBe(1)
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(1)

    // Lần import đầu (dự án mới) vẫn từ chối như cũ
    const seeded = await seedFixture("minimal")
    const fresh = await createMode1Project(seeded, "Fresh import")
    const bad = await DocxPackage.load(await makeSrsDocx())
    await addForeignMarkup(bad, SRS_FIXTURE_TEXT.purpose)
    await expect(uploadImport(fresh, seeded.userId, fileOf(await bad.toBuffer()))).rejects.toMatchObject({
      code: "IMPORT_FILE_REJECTED",
      meta: { issues: expect.arrayContaining([expect.objectContaining({ code: "FOREIGN_TRACK_CHANGE" }), expect.objectContaining({ code: "FOREIGN_COMMENT" })]) }
    })
  })

  it("chưa có baseline v0 ⇒ IMPORT_INVALID_STATE (lần đầu phải dùng /import)", async () => {
    const { projectId, userId } = await importAtExtracting()
    await expect(reupload(projectId, userId, fileOf(await makeSrsDocx()))).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
  })
})

/** Thêm Track Changes của người ngoài (chèn chữ) + một comment vào đoạn có chữ `text`. */
const addForeignMarkup = async (pkg: DocxPackage, text: string) => {
  const doc = await pkg.requireXml("word/document.xml")
  const target = para(doc, text)
  const ins = doc.createElementNS(W, "w:ins")
  ins.setAttributeNS(W, "w:id", "901")
  ins.setAttributeNS(W, "w:author", "Lan")
  ins.setAttributeNS(W, "w:date", "2026-11-20T00:00:00Z")
  const r = doc.createElementNS(W, "w:r")
  const t = doc.createElementNS(W, "w:t")
  t.setAttribute("xml:space", "preserve")
  t.textContent = " Customer note."
  r.appendChild(t)
  ins.appendChild(r)
  target.appendChild(ins)
  await addComment(pkg, target, "Please confirm the scope.", { author: "Khách hàng", date: new Date("2026-11-20T00:00:00Z") })
}

describe("FLF-457 - upload lại sau baseline: Track Changes người ngoài, bản cũ, file không dấu version", () => {
  it("dấu version cũ hơn bản hiện tại ⇒ vẫn so, kèm `stale`; đúng bản mới nhất ⇒ `stale = null`", async () => {
    const { projectId, userId } = await importFinalized()
    const { pkg } = await editVersion(projectId, () => undefined)
    const latest = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer())))
    expect(latest).toMatchObject({ stale: null, no_stamp: false, before_baseline: false })
    await writeStamp(pkg, { project_id: projectId, version: "0.0", source: "import" })
    const old = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer(), "SRS_old.docx")))
    expect(old).toMatchObject({ against_version: "0.1", stale: { file_version: "0.0", current_version: "0.1" } })
  })

  it("file không dấu version, heading khớp dưới ngưỡng ⇒ vẫn ra báo cáo, gợi ý Dùng làm tham khảo", async () => {
    const { projectId, userId } = await importFinalized()
    const other = await makeDocx({
      body:
        styled("u1", "1. Software Requirements Specification") +
        p("Functional requirements of the warehouse system.") +
        styled("u1", "2. Stock Movements") +
        p("The keeper records each stock movement.") +
        styled("u1", "3. Supplier Contracts") +
        p("Contracts are renewed every year.")
    })
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(other, "Warehouse.docx")))
    expect(dto).toMatchObject({ no_stamp: true, suggest_reference: true })
    expect(dto.heading_match).toBeLessThan(0.5)
  })
})

/** Dự án chế độ 3 đi Luồng 2 (đang soạn phần thiếu, `mode = fpt`): chưa có baseline, chưa có version. */
const beforeBaseline = async () => {
  const ctx = await importAtBaselining({ srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") } })
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: new mongoose.Types.ObjectId(ctx.projectId) }, { $set: { template_intent: "fixed", start_kind: "new" } })
  await startFinalize(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: (await spineRepository.get(ctx.projectId))!.spine_version })
  await waitForFinalize(ctx.importId)
  expect((await Project.findById(ctx.projectId).lean())!.mode).toBe("fpt")
  expect(await DocVersion.countDocuments({ projectId: ctx.projectId })).toBe(0)
  return ctx
}

/** Đúng file người dùng tải về bản DRAFT của nội dung đang soạn. */
const draftFile = async (projectId: string) => {
  const project = (await Project.findById(projectId))!
  return DocxPackage.load((await renderExportDocx(await contextOf(projectId, project), { source: "draft" })).buffer)
}

describe("FLF-457 - upload lại trước baseline (nội dung đang soạn)", () => {
  it("bản DRAFT của chính dự án sửa trong Word ⇒ báo khác biệt với nội dung đang soạn (`DRAFT`), không đổi Spine, không tạo version", async () => {
    const { projectId, userId } = await beforeBaseline()
    const pkg = await draftFile(projectId)
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId })
    const doc = await pkg.requireXml("word/document.xml")
    const target = paraEndingWith(doc, "Document Conventions")
    target.parentNode!.insertBefore(newPara(doc, "Dates use the ISO 8601 format."), target.nextSibling)
    const spineBefore = (await spineRepository.get(projectId))!.spine_version

    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer(), "Lumen_DRAFT.docx")))
    expect(dto).toMatchObject({ against_version: "DRAFT", before_baseline: true, no_stamp: false, stale: null, summary: { added: 1, removed: 0, modified: 0, moved: 0 } })
    expect(dto.blocks).toEqual([expect.objectContaining({ change: "added", after: "Dates use the ISO 8601 format." })])
    expect((await spineRepository.get(projectId))!.spine_version).toBe(spineBefore)
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
  })

  it("qua HTTP: dự án đang soạn (`mode = fpt`) gọi được /reupload; /import với bản DRAFT của chính dự án bị chặn, không đọc lại từ đầu", async () => {
    const { projectId, userId, importId } = await beforeBaseline()
    const user = (await User.findById(userId).lean())!
    const project = (await Project.findById(projectId).lean())!
    const token = await authAs({ _id: user._id, email: user.email, orgId: String(project.organizationId) })
    const buffer = await (await draftFile(projectId)).toBuffer()
    const res = await request(app).post(`/api/v1/projects/${projectId}/reupload`).set({ Authorization: `Bearer ${token}` }).attach("file", buffer, "Lumen_DRAFT.docx")
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({ against_version: "DRAFT", before_baseline: true, summary: { added: 0, removed: 0, modified: 0, moved: 0 } })

    await expect(uploadImport(projectId, userId, fileOf(buffer))).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE", meta: { status: "drafting" } })
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("drafting")
  })

  it("file không dấu version trước baseline ⇒ so với nội dung đang soạn, kèm `no_stamp`", async () => {
    const { projectId, userId } = await beforeBaseline()
    const pkg = await draftFile(projectId)
    const props = await pkg.requireXml("docProps/custom.xml")
    for (const el of Array.from(props.getElementsByTagName("property"))) el.parentNode?.removeChild(el)
    expect(await readStamp(pkg)).toBeNull()
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer(), "copy.docx")))
    expect(dto).toMatchObject({ against_version: "DRAFT", before_baseline: true, no_stamp: true, suggest_reference: false })
  })
})
