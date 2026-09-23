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

/** Tải file version 0.0 (bản render từ Spine + stamp — FLF-186), sửa như người dùng sửa trong Word. */
const editVersion = async (projectId: string, fn: (doc: Document) => void) => {
  const v = (await DocVersion.findOne({ projectId, version: "0.0" }).lean())!
  const pkg = await DocxPackage.load(await docFileStore().load(v.file_ref))
  fn(await pkg.requireXml("word/document.xml"))
  return { pkg, buffer: await pkg.toBuffer() }
}

const paraEndingWith = (doc: Document, suffix: string): Element => {
  const hit = Array.from(doc.getElementsByTagNameNS(W, "p")).find((x) => paraText(x).endsWith(suffix))
  if (!hit) throw new Error(`Không thấy đoạn kết thúc bằng "${suffix}"`)
  return hit
}

const snapshotCounts = async (projectId: string) => ({
  versions: await DocVersion.countDocuments({ projectId }),
  blocks: await DocBlock.countDocuments({ projectId }),
  spine: (await spineRepository.get(projectId))!.spine_version
})

describe("re-upload — diff theo block", () => {
  it("so với bản render 0.0 (FLF-186): thêm + xoá + sửa + di chuyển ⇒ đúng từng loại (khớp theo text); không tạo version, không đổi Spine/block", async () => {
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
    expect(dto).toMatchObject({ original_name: "SRS_Lumen_v2.docx", against_version: "0.0", summary: { added: 1, removed: 1, modified: 1, moved: 1 } })
    expect(dto.blocks).toEqual(
      expect.arrayContaining([
        { block_id: null, change: "modified", before: SRS_FIXTURE_TEXT.purpose, after: EDITED },
        { block_id: null, change: "removed", before: NOTES },
        { block_id: null, change: "moved", before: moved, after: moved },
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

  it("file không stamp (bản gốc sửa ngoài) ⇒ IMPORT_REUPLOAD_NO_STAMP, không lưu diff/file (BPMN: chỉ file có stamp mới đi 1.4)", async () => {
    const { projectId, userId } = await importFinalized()
    const pkg = await DocxPackage.load(await makeSrsDocx())
    const doc = await pkg.requireXml("word/document.xml")
    const extra = para(doc, SRS_FIXTURE_TEXT.purpose)
    extra.parentNode!.insertBefore(newPara(doc, "Brand new paragraph."), extra.nextSibling)
    await expect(reupload(projectId, userId, fileOf(await pkg.toBuffer()))).rejects.toMatchObject({ code: "IMPORT_REUPLOAD_NO_STAMP", statusCode: 422 })
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
