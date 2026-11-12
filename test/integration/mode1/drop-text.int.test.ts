/**
 * FLF-412 — màn đọc khung: chọn Bỏ chữ theo vùng heading (file là mẫu lấy từ dự án khác, chưa xoá chữ cũ). Lựa chọn chỉ đổi
 * bản sơ bộ + ước tính credit; bấm Bắt đầu thì file được viết lại (vùng bỏ chữ chỉ còn khung) và tách lại trước lượt đọc đầu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { waitForExtraction } from "../../../src/modules/import/extract-jobs.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

interface TextSection { key: string; title: string; level: number; dropped: boolean }

const upload = async (body: Record<string, unknown>) => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Warehouse XYZ", ...body })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(WRITTEN_SRS), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  return { seeded, projectId, importId: String(uploaded.body.data.import.id) }
}

const view = async (seeded: SeededFixture, projectId: string) => (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data
const drop = (seeded: SeededFixture, projectId: string, importId: string, keys: string[]) =>
  request(app).patch(`/api/v1/projects/${projectId}/import/drop-text`).set(H(seeded)).send({ import_id: importId, keys })

/** Đoạn chữ thật dài nhất dưới vùng `key` (chữ của dự án cũ). */
const realTextUnder = async (projectId: string, keys: readonly string[]): Promise<string[]> => {
  const blocks = await DocBlock.find({ projectId }).sort({ "anchor.ordinal": 1 }).lean()
  const out: string[] = []
  let open = false
  for (const b of blocks) {
    if (b.kind === "heading" && b.level === 1) open = keys.includes(b.block_id)
    if (open && b.kind === "paragraph" && b.text.trim().length > 40 && !b.text.includes("[")) out.push(b.text.trim())
  }
  return out
}

describe("FLF-412 - Bỏ chữ theo vùng ở màn đọc khung", () => {
  it("Bỏ tất cả ⇒ bản sơ bộ thành khung mẫu, không tốn lượt đọc; Bắt đầu viết lại file, chữ cũ không còn, không chọn lại được", async () => {
    const { seeded, projectId, importId } = await upload({ has_srs_file: true })
    const before = await view(seeded, projectId)
    expect(before.structure_preview.summary.kind).toBe("written")
    const sections = before.text_sections as TextSection[]
    expect(sections.length).toBeGreaterThan(3)
    expect(sections.every((s) => !s.dropped)).toBe(true)
    expect(before.credit_estimate.ai_calls).toBeGreaterThan(0)
    const level1 = (await DocBlock.find({ projectId, kind: "heading", level: 1 }).lean()).map((b) => b.block_id)
    const oldTexts = await realTextUnder(projectId, level1)
    expect(oldTexts.length).toBeGreaterThan(0)
    const originalRef = (await ImportedDocument.findById(importId))!.file_ref

    const res = await drop(seeded, projectId, importId, sections.map((s) => s.key))
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const after = await view(seeded, projectId)
    expect(after.structure_preview.summary).toMatchObject({ kind: "template", present: 0 })
    expect((after.text_sections as TextSection[]).every((s) => s.dropped)).toBe(true)
    expect(after.credit_estimate.text_batches).toBe(0)
    // Chưa Bắt đầu: file chưa đổi
    expect((await ImportedDocument.findById(importId))!.file_ref).toBe(originalRef)

    const started = await request(app).post(`/api/v1/projects/${projectId}/import/extract`).set(H(seeded)).send({ import_id: importId, confirm_latest: true })
    expect(started.status, JSON.stringify(started.body.error)).toBe(200)
    await waitForExtraction(importId)
    const doc = (await ImportedDocument.findById(importId))!
    expect(doc.file_ref).not.toBe(originalRef)
    // File tải lên gốc (còn chữ cũ của khách) bị xoá sau khi viết lại
    await expect(docFileStore().load(originalRef!)).rejects.toThrow()
    const texts = (await DocBlock.find({ projectId }).lean()).map((b) => b.text)
    for (const old of oldTexts) expect(texts).not.toContain(old)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.drop_text ?? null).toBeNull()

    const late = await drop(seeded, projectId, importId, [])
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("đang viết lại file (Bắt đầu chưa xong) ⇒ không chọn lại được", async () => {
    const { seeded, projectId, importId } = await upload({ has_srs_file: true })
    await ImportedDocument.updateOne({ _id: importId }, { $set: { drop_applying: true } })
    const res = await drop(seeded, projectId, importId, [])
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("Bỏ chữ một vùng ⇒ chỉ vùng đó thành còn trống; khoá lạ bị bỏ qua; Giữ tất cả quay lại như cũ", async () => {
    const { seeded, projectId, importId } = await upload({ has_srs_file: true })
    const before = await view(seeded, projectId)
    const first = (before.text_sections as TextSection[]).find((s) => s.title.includes("Actors"))!
    expect((await drop(seeded, projectId, importId, [first.key, "B9999"])).status).toBe(200)
    const partial = await view(seeded, projectId)
    expect((partial.text_sections as TextSection[]).filter((s) => s.dropped).map((s) => s.key)).toEqual([first.key])
    expect(partial.structure_preview.summary.present).toBeLessThan(before.structure_preview.summary.present)

    expect((await drop(seeded, projectId, importId, [])).status).toBe(200)
    const restored = await view(seeded, projectId)
    expect(restored.structure_preview.summary).toEqual(before.structure_preview.summary)
    expect(restored.credit_estimate.ai_calls).toBe(before.credit_estimate.ai_calls)
  })
})
