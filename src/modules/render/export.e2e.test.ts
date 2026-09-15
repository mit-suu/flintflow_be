import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import mammoth from "mammoth"
import type { Change, Spine } from "../spine/spine.types.js"
import { spineSchema } from "../spine/spine.schema.js"
import { _internal } from "./assemble.service.js"
import { writeDocx } from "./docx-writer.js"
import { makePng, readZipEntries, readZipText } from "./zip.test-helper.js"

/** Base64 của một PNG hợp lệ — writer kiểm `imageSize`, chuỗi giả không đủ. */
const pngBase64 = (seed: number): string => makePng(20 + seed, 10 + seed).toString("base64")

const FIXTURES = [
  new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url),
  new URL("../../../fixtures/spine-fixture-minimal.json", import.meta.url)
]

const load19Screens = (): Spine => spineSchema.parse(JSON.parse(readFileSync(FIXTURES[0], "utf8")))

const syntheticChanges: Change[] = [
  { projectId: "p", seq: 1, txn: "txn-1", op: "add", path: "actors[]", before: { _absent: true }, value: { id: "A01" }, reason: "Seed core actors", at: "2026-09-01T09:00:00.000Z", by: "650000000000000000000010", step_id: "S-3.1" },
  { projectId: "p", seq: 2, txn: "txn-1", op: "add", path: "actors[]", before: { _absent: true }, value: { id: "A02" }, reason: "Seed core actors", at: "2026-09-01T09:00:00.000Z", by: "650000000000000000000010", step_id: "S-3.1" },
  { projectId: "p", seq: 3, txn: "txn-2", op: "set", path: "project.vision", before: "old", value: "new", reason: "Refine product vision after review", at: "2026-09-05T10:00:00.000Z", by: "650000000000000000000010", step_id: "S-2.1" }
]

describe("export end-to-end — fixture 19 màn", () => {
  it("assemble → writeDocx: 5 chương, §I có dòng từ changes[], ảnh 5 diagram nhúng, watermark DRAFT", async () => {
    const spine = load19Screens()
    const doc = await _internal.buildDocument(
      {
        projectId: "650000000000000000000001",
        projectName: "FlintFlow",
        spine,
        statusChanges: syntheticChanges,
        recordChanges: syntheticChanges,
        source: "draft",
        version: "v0.1"
      },
      { loadDiagramPng: async (_p, id) => pngBase64(id.length), now: () => new Date("2026-09-15T00:00:00.000Z") }
    )

    // 5 diagram trong fixture đều render_status ok ⇒ 5 ảnh nhúng dưới dạng base64 string (writer chấp nhận string)
    const imagePngValues = doc.sections.flatMap((s) => s.blocks.filter((b) => b.type === "image").map((b) => b.png))
    expect(imagePngValues).toHaveLength(5)

    const docx = await writeDocx(doc)
    const documentXml = readZipText(docx, "word/document.xml")

    for (const title of ["1 Product Overview", "2 User Requirements", "3 Functional Requirements", "4 Non-Functional Requirements", "5 Requirement Appendix"]) {
      expect(documentXml).toContain(`${title}</w:t>`)
    }

    const roc = documentXml.indexOf("I. Record of Changes")
    expect(roc).toBeGreaterThan(-1)
    expect(documentXml).toContain("Seed core actors")
    expect(documentXml).toContain("Refine product vision after review")

    expect(documentXml).toContain("WORKING DRAFT")

    const { value: text } = await mammoth.extractRawText({ buffer: docx })
    expect(text).toContain("Software Requirement Specification")
  })

  it("baseline (spineSchema từ Baseline.snapshot giả lập): không watermark", async () => {
    const spine = load19Screens()
    const doc = await _internal.buildDocument(
      { projectId: "p1", projectName: "FlintFlow", spine, statusChanges: [], recordChanges: [], source: "baseline", version: "v1.0" },
      { loadDiagramPng: async () => null, now: () => new Date("2026-09-15T00:00:00.000Z") }
    )
    expect(doc.watermark).toBeUndefined()
    const docx = await writeDocx(doc)
    expect(readZipText(docx, "word/document.xml")).not.toContain("WORKING DRAFT")
  })

  it("5 chương xuất hiện đúng thứ tự trong sections[] (group:2..5 chèn trước nội dung chương)", async () => {
    const spine = load19Screens()
    const doc = await _internal.buildDocument(
      { projectId: "p1", projectName: "FlintFlow", spine, statusChanges: [], recordChanges: [], source: "draft", version: "v0.1" },
      { loadDiagramPng: async () => null, now: () => new Date() }
    )
    const ids = doc.sections.map((s) => s.id)
    expect(ids[0]).toBe("fixed:1")
    expect(ids.indexOf("group:2")).toBeLessThan(ids.indexOf("fixed:2.1"))
    expect(ids.indexOf("group:3")).toBeLessThan(ids.indexOf("fixed:3.1.1"))
    expect(ids.indexOf("group:4")).toBeLessThan(ids.indexOf("fixed:4.1"))
    expect(ids.indexOf("group:5")).toBeLessThan(ids.indexOf("fixed:5.1"))
    expect(ids).not.toContain("fixed:I")
  })

  it("readZipEntries đọc được media nhúng (zip OOXML hợp lệ)", async () => {
    const spine = load19Screens()
    const doc = await _internal.buildDocument(
      { projectId: "p1", projectName: "FlintFlow", spine, statusChanges: [], recordChanges: [], source: "draft", version: "v0.1" },
      { loadDiagramPng: async (_p, id) => pngBase64(id.length), now: () => new Date() }
    )
    const docx = await writeDocx(doc)
    const media = [...readZipEntries(docx).keys()].filter((n) => n.startsWith("word/media/"))
    expect(media.length).toBeGreaterThan(0)
  })
})

describe("cấm số hiệu section cứng trong field prose của fixture", () => {
  const HARDCODED_SECTION_REF = /§\s*\d+(\.\d+){0,3}|\bsection\s+\d+(\.\d+){1,3}\b/i

  const walk = (value: unknown, hits: string[]): void => {
    if (typeof value === "string") {
      if (HARDCODED_SECTION_REF.test(value)) hits.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, hits)
      return
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v, hits)
    }
  }

  it.each(FIXTURES.map((url) => [url.pathname.split("/").pop() ?? String(url), url] as const))("%s không chứa chuỗi số section cứng (§3.x / \"section 3.x\")", (_name, url) => {
    const data: unknown = JSON.parse(readFileSync(url, "utf8"))
    const hits: string[] = []
    walk(data, hits)
    expect(hits).toEqual([])
  })
})
