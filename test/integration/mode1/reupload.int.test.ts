/**
 * Re-upload sau baseline (nút 1.4, UC-24) ở tầng service trên Mongo thật — plan §8.2 `reupload.test.ts`. FLF-172 P4.
 * Thêm/xoá/sửa/di chuyển block; không tạo version; stamp project khác bị từ chối.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { fileOf, importAtExtracting, importFinalized } from "../../helpers/mode1-import-p4.js"
import { reupload, toReuploadDto } from "../../../src/modules/import/reupload.service.js"
import { ReuploadDiff } from "../../../src/modules/import/reupload-diff.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocxPackage, writeStamp } from "../../../src/modules/docx-ooxml/index.js"
import { makeDocx, p } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { SRS_FIXTURE_TEXT, makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

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

/** Tải file version 0.0 (có stamp + bookmark), sửa như người dùng sửa trong Word. */
const editVersion = async (projectId: string, fn: (doc: Document) => void) => {
  const v = (await DocVersion.findOne({ projectId, version: "0.0" }).lean())!
  const pkg = await DocxPackage.load(await docFileStore().load(v.file_ref))
  fn(await pkg.requireXml("word/document.xml"))
  return { pkg, buffer: await pkg.toBuffer() }
}

const snapshotCounts = async (projectId: string) => ({
  versions: await DocVersion.countDocuments({ projectId }),
  blocks: await DocBlock.countDocuments({ projectId }),
  spine: (await spineRepository.get(projectId))!.spine_version
})

describe("re-upload — diff theo block", () => {
  it("thêm + xoá + sửa + di chuyển ⇒ đúng từng loại, block_id theo neo; không tạo version, không đổi Spine/block", async () => {
    const { projectId, userId, importId } = await importFinalized()
    const blockOf = async (text: string) => (await DocBlock.findOne({ projectId, text }).lean())!.block_id
    const [perfId, diagramId, purposeId] = [await blockOf(SRS_FIXTURE_TEXT.perf), await blockOf("The diagram shows UC-01 and UC-02."), await blockOf(SRS_FIXTURE_TEXT.purpose)]
    const before = await snapshotCounts(projectId)

    const { buffer } = await editVersion(projectId, (doc) => {
      setText(para(doc, SRS_FIXTURE_TEXT.perf), "The system shall respond within 1 second.")
      const del = para(doc, "The diagram shows UC-01 and UC-02.")
      del.parentNode!.removeChild(del)
      const mv = para(doc, SRS_FIXTURE_TEXT.purpose)
      mv.parentNode!.removeChild(mv)
      const notes = para(doc, "Internal notes that do not belong to the template.")
      notes.parentNode!.insertBefore(mv, notes)
      notes.parentNode!.insertBefore(newPara(doc, "Added after baseline."), notes.nextSibling)
    })
    const diff = await reupload(projectId, userId, fileOf(buffer, "SRS_Lumen_v2.docx"))
    const dto = toReuploadDto(diff)
    expect(dto).toMatchObject({ original_name: "SRS_Lumen_v2.docx", against_version: "0.0", summary: { added: 1, removed: 1, modified: 1, moved: 1 } })
    expect(dto.blocks).toEqual(
      expect.arrayContaining([
        { block_id: perfId, change: "modified", before: SRS_FIXTURE_TEXT.perf, after: "The system shall respond within 1 second." },
        { block_id: diagramId, change: "removed", before: "The diagram shows UC-01 and UC-02." },
        { block_id: purposeId, change: "moved", before: SRS_FIXTURE_TEXT.purpose, after: SRS_FIXTURE_TEXT.purpose },
        { block_id: null, change: "added", after: "Added after baseline." }
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

  it("file không stamp (bản gốc sửa ngoài) vẫn so được theo text", async () => {
    const { projectId, userId } = await importFinalized()
    const original = await makeSrsDocx()
    const pkg = await DocxPackage.load(original)
    const doc = await pkg.requireXml("word/document.xml")
    const extra = para(doc, SRS_FIXTURE_TEXT.purpose)
    extra.parentNode!.insertBefore(newPara(doc, "Brand new paragraph."), extra.nextSibling)
    const dto = toReuploadDto(await reupload(projectId, userId, fileOf(await pkg.toBuffer())))
    expect(dto.summary).toEqual({ added: 1, removed: 0, modified: 0, moved: 0 })
  })
})

describe("re-upload — từ chối", () => {
  it("stamp của project khác ⇒ IMPORT_STAMP_FOREIGN_PROJECT, không lưu diff/file", async () => {
    const { projectId, userId } = await importFinalized()
    const { pkg } = await editVersion(projectId, () => undefined)
    await writeStamp(pkg, { project_id: "66f0000000000000000000ff", version: "0.3", source: "cr_revision" })
    await expect(reupload(projectId, userId, fileOf(await pkg.toBuffer()))).rejects.toMatchObject({
      code: "IMPORT_STAMP_FOREIGN_PROJECT",
      meta: { stamp: { project_id: "66f0000000000000000000ff" } }
    })
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(0)
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })

  it("file có Track Changes tác giả lạ ⇒ IMPORT_FILE_REJECTED kèm vị trí", async () => {
    const { projectId, userId } = await importFinalized()
    const bad = await makeDocx({ body: p("A") + `<w:p><w:ins w:id="1" w:author="Lan"><w:r><w:t>B</w:t></w:r></w:ins></w:p>` })
    await expect(reupload(projectId, userId, fileOf(bad))).rejects.toMatchObject({
      code: "IMPORT_FILE_REJECTED",
      meta: { issues: [{ code: "FOREIGN_TRACK_CHANGE", location: { block_ord: 1 } }] }
    })
    expect(await ReuploadDiff.countDocuments({ projectId })).toBe(0)
  })

  it("chưa có baseline v0 ⇒ IMPORT_INVALID_STATE (lần đầu phải dùng /import)", async () => {
    const { projectId, userId } = await importAtExtracting()
    await expect(reupload(projectId, userId, fileOf(await makeSrsDocx()))).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
  })
})
