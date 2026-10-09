/**
 * FLF-265 phase 3 §3.1 + §3.6 — tài liệu theo ngôn ngữ dự án qua HTTP trên Mongo thật:
 * GET /document (meta.translation, data đúng khuôn, `?lang=` bị bỏ qua), GET /export/word (X-Document-Language,
 * bìa / mục lục tiếng Việt), file version mode 1 không đổi; không đường nào gọi model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/ai-action.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/ai/ai-action.service.js")>()
  return { ...actual, executeAiAction: vi.fn(actual.executeAiAction) }
})

import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { executeAiAction } from "../../src/shared/ai/ai-action.service.js"
import { renderedDocumentSchema } from "../../src/modules/render/rendered-document.schema.js"
import { documentTranslationMetaSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { GROUP_HEADINGS, WRITER_TEXT } from "../../src/modules/render/labels.js"
import { renderVersionFile } from "../../src/modules/doc-version/render-version.js"
import { renderSpineDocument } from "../../src/modules/render/assemble.service.js"
import { writeDocx } from "../../src/modules/render/docx-writer.js"
import { readZipText } from "../../src/modules/render/zip.test-helper.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import { saveTranslations } from "../../src/modules/translation/translation.repository.js"
import { hashSource, translationUnits } from "../../src/modules/translation/translation-units.js"
import { stripRecord } from "../../src/modules/import/check.service.js"

const client = (seeded: SeededFixture) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    patchLanguage: (documentLanguage: string) => request(app).patch(`${base}/document-language`).set(auth).send({ documentLanguage }),
    download: (suffix: string) =>
      request(app)
        .get(`${base}${suffix}`)
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => done(null, Buffer.concat(chunks)))
        })
  }
}

const headings = (data: unknown): string[] => renderedDocumentSchema.parse(data).sections.map((s) => s.heading)

let seeded: SeededFixture
let api: ReturnType<typeof client>

beforeEach(async () => {
  vi.mocked(executeAiAction).mockClear()
  seeded = await seedFixture("minimal")
  api = client(seeded)
})

describe("dự án mode 2 vi", () => {
  beforeEach(async () => {
    expect((await api.patchLanguage("vi")).status).toBe(200)
  })

  it("GET /document: meta.translation khớp /translations/status, data qua schema strict, nhãn vi; ?lang=en bị bỏ qua", async () => {
    const status = await api.get("/translations/status")
    expect(status.status).toBe(200)
    expect(status.body.data.missing).toBeGreaterThan(0)

    const res = await api.get("/document?source=draft&lang=en")
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(documentTranslationMetaSchema.parse(res.body.meta.translation)).toEqual({ locale: "vi", source_locale: "en", missing: status.body.data.missing })
    // Bản dịch dựng mới, không qua cache ⇒ độ mới của chính bản vừa dựng
    expect(res.body.meta).toMatchObject({ assembled_at_version: seeded.spineVersion, spine_version: seeded.spineVersion, stale: false })
    expect(renderedDocumentSchema.safeParse(res.body.data).success).toBe(true)
    expect(headings(res.body.data)).toContain(GROUP_HEADINGS.vi["2"])
    expect(headings(res.body.data)).not.toContain(GROUP_HEADINGS.en["2"])
  })

  it("có bản dịch ⇒ chữ dịch in ra, missing giảm đúng như /translations/status", async () => {
    const spine = (await spineRepository.get(seeded.projectId))!
    const unit = translationUnits(spine).find((u) => u.key.startsWith("project.") && typeof u.value === "string")!
    expect(unit).toBeDefined()
    const marker = "BẢN DỊCH THỬ FLF-265"
    await saveTranslations(seeded.projectId, "vi", "en", [{ sourceHash: hashSource(unit.value), text: marker }], "author")

    const status = await api.get("/translations/status")
    const res = await api.get("/document?source=draft")
    expect(res.body.meta.translation.missing).toBe(status.body.data.missing)
    expect(JSON.stringify(res.body.data)).toContain(marker)
  })

  it("GET /export/word: X-Document-Language vi, bìa + mục lục tiếng Việt, phiên bản theo bản vừa dựng", async () => {
    const res = await api.download("/export/word?source=draft&lang=en")
    expect(res.status).toBe(200)
    expect(res.headers["x-document-language"]).toBe("vi")
    expect(res.headers["x-spine-version"]).toBe(String(seeded.spineVersion))
    const xml = readZipText(res.body as Buffer, "word/document.xml")
    expect(xml).toContain(WRITER_TEXT.vi.toc)
    expect(xml).toContain(WRITER_TEXT.vi.coverTitle)
    expect(xml).not.toContain(WRITER_TEXT.en.toc)
  })

  it("§3.6: document + export + render-version không gọi model dù còn thiếu bản dịch", async () => {
    await api.get("/document?source=draft")
    await api.download("/export/word?source=draft")
    const spine = stripRecord((await spineRepository.get(seeded.projectId))!)
    await renderVersionFile(seeded.projectId, "Demo", spine, { version: "1.0", stampSource: "release" })
    expect(executeAiAction).not.toHaveBeenCalled()
  })
})

describe("dự án mode 2 en (dự án cũ không có documentLanguage)", () => {
  it("không có meta.translation, header en, mục lục tiếng Anh", async () => {
    const res = await api.get("/document?source=draft&lang=vi")
    expect(res.status).toBe(200)
    expect(res.body.meta.translation).toBeUndefined()
    expect(headings(res.body.data)).toContain(GROUP_HEADINGS.en["2"])

    const word = await api.download("/export/word?source=draft")
    expect(word.headers["x-document-language"]).toBe("en")
    expect(readZipText(word.body as Buffer, "word/document.xml")).toContain(WRITER_TEXT.en.toc)
    expect(executeAiAction).not.toHaveBeenCalled()
  })
})

describe("renderVersionFile (file version mode 1)", () => {
  it("document.xml y hệt bản ghi bằng { flagLanguage: vi } cũ, không gọi model", async () => {
    const spine = stripRecord((await spineRepository.get(seeded.projectId))!)
    const opts = { version: "1.0", stampSource: "release" }
    const file = await renderVersionFile(seeded.projectId, "Demo", spine, opts)
    const doc = await renderSpineDocument(seeded.projectId, "Demo", spine, { version: "1.0", source: "baseline" })
    const old = await writeDocx(doc, { flagLanguage: "vi" })
    expect(readZipText(file, "word/document.xml")).toBe(readZipText(old, "word/document.xml"))
    expect(executeAiAction).not.toHaveBeenCalled()
  })
})
