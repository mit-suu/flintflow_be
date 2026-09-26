/**
 * Bản tải có đánh dấu (BPMN 3.14, mode 1 v3 — nợ T6 + T7): so đoạn giữa hai bản render, ghi `w:ins` / `w:del` tác giả
 * CR id, comment ở tiêu đề mục. Accept-all ⇒ đúng bản mới; Reject-all ⇒ đúng bản cũ.
 */
import { describe, expect, it } from "vitest"
import { DocxPackage, acceptAll, listComments, paragraphText, readBlocks } from "../docx-ooxml/index.js"
import { makeDocx, p } from "../docx-ooxml/testing/make-docx.js"
import { wAll, wAttr } from "../docx-ooxml/xml.js"
import { buildTrackedDocx, pairParagraphs, similarity } from "./tracked-version.js"

const DATE = new Date("2026-09-22T10:00:00Z")
const docx = (paras: string[]) => makeDocx({ body: paras.map((t) => p(t)).join("") })

/** Text từng đoạn sau Reject all (bỏ ins, giữ del) — bản cũ phải còn nguyên. */
const rejectedTexts = async (data: Buffer): Promise<string[]> => {
  const pkg = await DocxPackage.load(data)
  const doc = await pkg.requireXml("word/document.xml")
  for (const ins of wAll(doc, "ins")) ins.parentNode!.removeChild(ins)
  for (const del of wAll(doc, "del")) {
    for (const dt of wAll(del, "delText")) {
      const t = dt.ownerDocument.createElementNS(dt.namespaceURI, "w:t")
      t.textContent = dt.textContent
      dt.parentNode!.replaceChild(t, dt)
    }
    while (del.firstChild) del.parentNode!.insertBefore(del.firstChild, del)
    del.parentNode!.removeChild(del)
  }
  return wAll(doc, "p").map(paragraphText).filter((t) => t.length > 0)
}

const acceptedTexts = async (data: Buffer): Promise<string[]> => {
  const pkg = await DocxPackage.load(data)
  await acceptAll(pkg)
  return (await readBlocks(pkg)).map((b) => b.text).filter((t) => t.length > 0)
}

describe("pairParagraphs", () => {
  it("không đổi ⇒ rỗng; sửa một đoạn ⇒ modified đúng chỉ số", () => {
    expect(pairParagraphs(["A b c", "D e f"], ["A b c", "D e f"])).toEqual([])
    expect(pairParagraphs(["Intro", "The system responds within 2 seconds.", "End"], ["Intro", "The system responds within 1 second.", "End"])).toEqual([
      { kind: "modified", before: "The system responds within 2 seconds.", after: "The system responds within 1 second.", next_index: 1 }
    ])
  })

  it("thêm / xoá đoạn giữa; cặp khác hẳn nhau ⇒ xoá + thêm, không coi là sửa", () => {
    expect(pairParagraphs(["A", "C"], ["A", "B new", "C"])).toEqual([{ kind: "added", before: "", after: "B new", next_index: 1 }])
    expect(pairParagraphs(["A", "B old", "C"], ["A", "C"])).toEqual([{ kind: "removed", before: "B old", after: "", next_index: 1 }])
    expect(pairParagraphs(["A", "Passwords need 8 characters", "C"], ["A", "Brand new paragraph", "C"])).toEqual([
      { kind: "removed", before: "Passwords need 8 characters", after: "", next_index: 1 },
      { kind: "added", before: "", after: "Brand new paragraph", next_index: 1 }
    ])
    // xoá đoạn cuối ⇒ chèn đoạn đã xoá ở cuối (next_index = số đoạn)
    expect(pairParagraphs(["A", "Z"], ["A"])).toEqual([{ kind: "removed", before: "Z", after: "", next_index: 1 }])
  })

  it("similarity theo từ chung", () => {
    expect(similarity("respond within 2 seconds", "respond within 1 second")).toBeCloseTo(0.5)
    expect(similarity("", "")).toBe(1)
    expect(similarity("abc", "xyz")).toBe(0)
  })
})

describe("buildTrackedDocx", () => {
  it("ghi w:ins / w:del tác giả CR id; accept-all ⇒ bản mới, reject-all ⇒ bản cũ; comment ở đầu", async () => {
    const prev = await docx(["Introduction", "The system responds within 2 seconds.", "Old paragraph that will disappear.", "Glossary"])
    const next = await docx(["Introduction", "The system responds within 1 second.", "Glossary", "CR-001: Faster response"])
    const out = await buildTrackedDocx(prev, next, { author: "CR-001", date: DATE }, [{ section_title: "Không có mục này", text: "Xem lại mục hiệu năng" }])
    expect(out.changes).toBe(3)
    expect(out.skipped).toBe(0)

    const doc = await (await DocxPackage.load(out.data)).requireXml("word/document.xml")
    const marks = [...wAll(doc, "ins"), ...wAll(doc, "del")]
    expect(marks.length).toBeGreaterThan(0)
    expect(new Set(marks.map((m) => wAttr(m, "author")))).toEqual(new Set(["CR-001"]))

    expect(await acceptedTexts(out.data)).toEqual(["Introduction", "The system responds within 1 second.", "Glossary", "CR-001: Faster response"])
    expect(await rejectedTexts(out.data)).toEqual(["Introduction", "The system responds within 2 seconds.", "Old paragraph that will disappear.", "Glossary"])

    const comments = await listComments(await DocxPackage.load(out.data))
    expect(comments).toMatchObject([{ author: "CR-001", text: "Xem lại mục hiệu năng" }])
  })

  it("hai bản giống hệt ⇒ không đánh dấu gì", async () => {
    const same = await docx(["A", "B"])
    const out = await buildTrackedDocx(same, same, { author: "CR-002", date: DATE })
    expect(out.changes).toBe(0)
    const doc = await (await DocxPackage.load(out.data)).requireXml("word/document.xml")
    expect(wAll(doc, "ins")).toHaveLength(0)
  })
})
