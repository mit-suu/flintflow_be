/**
 * Re-upload (nút 1.4, UC-24) — phần hàm thuần: so block của file mới với block của version đã lưu theo đúng cách
 * `reupload.service.ts` làm (bookmark neo → paraId → LCS text_hash), trên .docx thật; DTO tóm tắt.
 * Plan §8.2 `reupload.test.ts`. FLF-172 P4. Phần DB (không tạo version, stamp project khác bị từ chối) ở
 * `test/integration/mode1/reupload.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import mongoose from "mongoose"
import { DocxPackage, blockIdOfBookmark, readBlocks } from "../docx-ooxml/index.js"
import { diffBlockLists } from "../doc-version/block-diff.js"
import { parseDocument } from "./parse.service.js"
import { ReuploadDiff } from "./reupload-diff.model.js"
import { toReuploadDto } from "./reupload.service.js"
import { SRS_FIXTURE_TEXT, makeSrsDocx } from "./testing/srs-fixture.js"

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

const paraText = (p: Element): string =>
  Array.from(p.getElementsByTagNameNS(W, "t"))
    .map((t) => t.textContent ?? "")
    .join("")

const bodyParas = (doc: Document): Element[] => Array.from(doc.getElementsByTagNameNS(W, "p"))
const para = (doc: Document, text: string): Element => {
  const hit = bodyParas(doc).find((p) => paraText(p) === text)
  if (!hit) throw new Error(`Không thấy đoạn "${text}"`)
  return hit
}
const setText = (p: Element, text: string): void => {
  const ts = Array.from(p.getElementsByTagNameNS(W, "t"))
  ts[0].textContent = text
  for (const t of ts.slice(1)) t.parentNode?.removeChild(t)
}
/** Đoạn mới gõ trong Word: không có bookmark FlintFlow, không có paraId cũ. */
const freshPara = (doc: Document, text: string): Element => {
  const p = doc.createElementNS(W, "w:p")
  const r = doc.createElementNS(W, "w:r")
  const t = doc.createElementNS(W, "w:t")
  t.textContent = text
  r.appendChild(t)
  p.appendChild(r)
  return p
}

/** "Version 0.0" = file gốc đã gán block_id + bookmark (như finalize lưu). */
const savedVersion = async () => {
  const parsed = await parseDocument(await makeSrsDocx())
  return { old: parsed.blocks, buffer: await parsed.pkg.toBuffer() }
}

/** Diff như `reupload.service.ts`. */
const diffAgainst = async (old: Awaited<ReturnType<typeof savedVersion>>["old"], file: Buffer) => {
  const fresh = await readBlocks(await DocxPackage.load(file))
  return diffBlockLists(
    old.map((b) => ({ block_id: b.block_id, para_id: b.para_id, text: b.text, text_hash: b.text_hash })),
    fresh.map((b) => ({ block_id: blockIdOfBookmark(b.bookmark), para_id: b.para_id, text: b.text, text_hash: b.text_hash }))
  )
}

const edit = async (buffer: Buffer, fn: (doc: Document) => void): Promise<Buffer> => {
  const pkg = await DocxPackage.load(buffer)
  fn(await pkg.requireXml("word/document.xml"))
  return pkg.toBuffer()
}

describe("re-upload diff theo block", () => {
  it("file không đổi ⇒ không có dòng diff", async () => {
    const { old, buffer } = await savedVersion()
    expect(await diffAgainst(old, buffer)).toEqual({ blocks: [], summary: { added: 0, removed: 0, modified: 0, moved: 0 } })
  })

  it("sửa chữ trong đoạn ⇒ modified, giữ block_id theo bookmark", async () => {
    const { old, buffer } = await savedVersion()
    const file = await edit(buffer, (doc) => setText(para(doc, SRS_FIXTURE_TEXT.perf), "The system shall respond within 1 second."))
    const { blocks, summary } = await diffAgainst(old, file)
    expect(summary).toEqual({ added: 0, removed: 0, modified: 1, moved: 0 })
    const perf = old.find((b) => b.text === SRS_FIXTURE_TEXT.perf)!
    expect(blocks).toEqual([{ block_id: perf.block_id, change: "modified", before: SRS_FIXTURE_TEXT.perf, after: "The system shall respond within 1 second." }])
  })

  it("thêm đoạn mới (chưa có id) ⇒ added với block_id null", async () => {
    const { old, buffer } = await savedVersion()
    const file = await edit(buffer, (doc) => {
      const anchor = para(doc, SRS_FIXTURE_TEXT.purpose)
      anchor.parentNode!.insertBefore(freshPara(doc, "Lumen also supports mobile."), anchor.nextSibling)
    })
    expect(await diffAgainst(old, file)).toEqual({
      blocks: [{ block_id: null, change: "added", after: "Lumen also supports mobile." }],
      summary: { added: 1, removed: 0, modified: 0, moved: 0 }
    })
  })

  it("xoá đoạn ⇒ removed kèm text cũ", async () => {
    const { old, buffer } = await savedVersion()
    const file = await edit(buffer, (doc) => {
      const p = para(doc, "Internal notes that do not belong to the template.")
      p.parentNode!.removeChild(p)
    })
    const notes = old.find((b) => b.text === "Internal notes that do not belong to the template.")!
    expect(await diffAgainst(old, file)).toEqual({
      blocks: [{ block_id: notes.block_id, change: "removed", before: notes.text }],
      summary: { added: 0, removed: 1, modified: 0, moved: 0 }
    })
  })

  it("di chuyển đoạn (giữ bookmark) ⇒ moved, không phải xoá + thêm", async () => {
    const { old, buffer } = await savedVersion()
    const file = await edit(buffer, (doc) => {
      const p = para(doc, SRS_FIXTURE_TEXT.purpose)
      const target = para(doc, "Internal notes that do not belong to the template.")
      p.parentNode!.removeChild(p)
      target.parentNode!.insertBefore(p, target)
    })
    const { blocks, summary } = await diffAgainst(old, file)
    expect(summary).toEqual({ added: 0, removed: 0, modified: 0, moved: 1 })
    expect(blocks[0]).toMatchObject({ block_id: old.find((b) => b.text === SRS_FIXTURE_TEXT.purpose)!.block_id, change: "moved" })
  })

  it("cả bốn loại cùng lúc ⇒ đếm đúng từng loại", async () => {
    const { old, buffer } = await savedVersion()
    const file = await edit(buffer, (doc) => {
      setText(para(doc, SRS_FIXTURE_TEXT.loginNormal), "The learner enters email and OTP.")
      const del = para(doc, "The diagram shows UC-01 and UC-02.")
      del.parentNode!.removeChild(del)
      const mv = para(doc, SRS_FIXTURE_TEXT.purpose)
      mv.parentNode!.removeChild(mv)
      const before = para(doc, "Internal notes that do not belong to the template.")
      before.parentNode!.insertBefore(mv, before)
      before.parentNode!.insertBefore(freshPara(doc, "New closing note."), before.nextSibling)
    })
    expect((await diffAgainst(old, file)).summary).toEqual({ added: 1, removed: 1, modified: 1, moved: 1 })
  })

  it("file không có bookmark FlintFlow (bản gốc sửa ngoài) ⇒ khớp theo text, đoạn sửa thành removed + added", async () => {
    const original = await makeSrsDocx()
    const { blocks: old } = await parseDocument(original)
    const file = await edit(original, (doc) => setText(para(doc, SRS_FIXTURE_TEXT.perf), "Faster."))
    const { summary } = await diffAgainst(old, file)
    // không neo, không paraId ⇒ LCS theo text_hash: các block khác khớp, block đổi chữ không ghép được
    expect(summary).toEqual({ added: 1, removed: 1, modified: 0, moved: 0 })
  })
})

describe("toReuploadDto", () => {
  it("tóm tắt đếm theo loại, block_id null giữ nguyên, bỏ trường trống", () => {
    const d = new ReuploadDiff({
      projectId: new mongoose.Types.ObjectId(),
      file_ref: "f",
      sha256: "x".repeat(64),
      original_name: "v2.docx",
      against_version: "0.0",
      created_by: new mongoose.Types.ObjectId(),
      blocks: [
        { block_id: null, change: "added", after: "a" },
        { block_id: "B0002", change: "removed", before: "b" },
        { block_id: "B0003", change: "modified", before: "c", after: "d" }
      ]
    })
    d.createdAt = new Date("2026-09-19T00:00:00Z")
    const dto = toReuploadDto(d)
    expect(dto).toMatchObject({ original_name: "v2.docx", against_version: "0.0", created_at: "2026-09-19T00:00:00.000Z", summary: { added: 1, removed: 1, modified: 1, moved: 0 } })
    expect(dto.blocks[0]).toEqual({ block_id: null, change: "added", after: "a" })
    expect(dto.blocks[1]).toEqual({ block_id: "B0002", change: "removed", before: "b" })
  })
})
