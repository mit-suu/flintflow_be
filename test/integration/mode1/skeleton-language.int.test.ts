/**
 * FLF-456 — ngôn ngữ tài liệu khi file chỉ còn khung (business-flow §3.1.2): ô EN / VI chỉ hiện khi mọi mục có chữ đã Bỏ chữ;
 * chọn khác ngôn ngữ file thì khung được dịch một lần lúc bấm Bắt đầu, credit báo trước có cộng phần dịch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { waitForExtraction } from "../../../src/modules/import/extract-jobs.js"

const BATCH_PROMPT = "You translate a batch of texts"
let translateBatches = 0

/** Provider giả cho `translate_document`: "dịch" bằng tiền tố `[vi] `. */
const echoTranslate = (prompt: string): string | undefined => {
  if (!prompt.includes(BATCH_PROMPT)) return undefined
  translateBatches++
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf("Items:") + "Items:".length).trim()) as { key: string; text: string }[]
  return JSON.stringify({ items: items.map(({ key, text }) => ({ key, text: `[vi] ${text}` })) })
}

beforeEach(() => {
  resetMockLlm()
  translateBatches = 0
  mockOverrides.next = (prompt) => echoTranslate(prompt) ?? fakeMode1(prompt)
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

interface TextSection { key: string; title: string; dropped: boolean }

const upload = async () => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Warehouse XYZ", has_srs_file: true })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(WRITTEN_SRS), "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  return { seeded, projectId, importId: String(uploaded.body.data.import.id) }
}

const view = async (seeded: SeededFixture, projectId: string) => (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data
const drop = (seeded: SeededFixture, projectId: string, importId: string, keys: string[]) =>
  request(app).patch(`/api/v1/projects/${projectId}/import/drop-text`).set(H(seeded)).send({ import_id: importId, keys })
const choose = (seeded: SeededFixture, projectId: string, importId: string, language: string) =>
  request(app).patch(`/api/v1/projects/${projectId}/import/document-language`).set(H(seeded)).send({ import_id: importId, language })
const start = (seeded: SeededFixture, projectId: string, importId: string) =>
  request(app).post(`/api/v1/projects/${projectId}/import/extract`).set(H(seeded)).send({ import_id: importId, confirm_latest: true })

describe("FLF-456 - ngôn ngữ tài liệu khi file chỉ còn khung", () => {
  it("file tiếng Anh chỉ còn khung, chọn VI ⇒ khung xuất ra tiếng Việt, credit báo có phần dịch", async () => {
    const { seeded, projectId, importId } = await upload()
    const sections = (await view(seeded, projectId)).text_sections as TextSection[]
    expect((await drop(seeded, projectId, importId, sections.map((s) => s.key))).status).toBe(200)

    const before = await view(seeded, projectId)
    expect(before.skeleton_language).toEqual({ visible: true, file: "en", selected: "en" })
    expect(before.credit_estimate.translate_batches).toBe(0)

    expect((await choose(seeded, projectId, importId, "vi")).status).toBe(200)
    const chosen = await view(seeded, projectId)
    expect(chosen.skeleton_language).toEqual({ visible: true, file: "en", selected: "vi" })
    expect(chosen.credit_estimate.translate_batches).toBeGreaterThan(0)
    expect(chosen.credit_estimate.credits).toBeGreaterThan(before.credit_estimate.credits)
    expect(chosen.credit_estimate.ai_calls).toBe(before.credit_estimate.ai_calls + chosen.credit_estimate.translate_batches)

    const started = await start(seeded, projectId, importId)
    expect(started.status, JSON.stringify(started.body.error)).toBe(200)
    await waitForExtraction(importId)
    const headings = (await DocBlock.find({ projectId, kind: "heading" }).lean()).map((b) => b.text)
    expect(headings.length).toBeGreaterThan(3)
    expect(headings.every((h) => h.includes("[vi] "))).toBe(true)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.language).toBe("vi")
    expect(translateBatches).toBe(chosen.credit_estimate.translate_batches)
    expect(mockCalls.length).toBeGreaterThanOrEqual(translateBatches)
  })

  it("còn một mục giữ nội dung ⇒ không có ô, không chọn được, ngôn ngữ theo file", async () => {
    const { seeded, projectId, importId } = await upload()
    const sections = (await view(seeded, projectId)).text_sections as TextSection[]
    expect((await drop(seeded, projectId, importId, sections.slice(1).map((s) => s.key))).status).toBe(200)

    const partial = await view(seeded, projectId)
    expect(partial.skeleton_language).toEqual({ visible: false, file: "en", selected: "en" })
    const res = await choose(seeded, projectId, importId, "vi")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("chọn VI rồi Giữ lại một mục: ô ẩn, Bắt đầu không dịch, ngôn ngữ theo file", async () => {
    const { seeded, projectId, importId } = await upload()
    const sections = (await view(seeded, projectId)).text_sections as TextSection[]
    expect((await drop(seeded, projectId, importId, sections.map((s) => s.key))).status).toBe(200)
    expect((await choose(seeded, projectId, importId, "vi")).status).toBe(200)
    expect((await drop(seeded, projectId, importId, sections.slice(1).map((s) => s.key))).status).toBe(200)
    const after = await view(seeded, projectId)
    expect(after.skeleton_language).toEqual({ visible: false, file: "en", selected: "en" })
    expect(after.credit_estimate.translate_batches).toBe(0)

    expect((await start(seeded, projectId, importId)).status).toBe(200)
    await waitForExtraction(importId)
    const headings = (await DocBlock.find({ projectId, kind: "heading" }).lean()).map((b) => b.text)
    expect(headings.some((h) => h.includes("[vi] "))).toBe(false)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.language).toBe("en")
    expect(translateBatches).toBe(0)
  })

  it("chọn đúng ngôn ngữ file ⇒ không dịch, không tốn thêm", async () => {
    const { seeded, projectId, importId } = await upload()
    const sections = (await view(seeded, projectId)).text_sections as TextSection[]
    expect((await drop(seeded, projectId, importId, sections.map((s) => s.key))).status).toBe(200)
    expect((await choose(seeded, projectId, importId, "en")).status).toBe(200)
    expect((await view(seeded, projectId)).credit_estimate.translate_batches).toBe(0)
  })
})
