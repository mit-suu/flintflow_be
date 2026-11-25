/**
 * FLF-463 — cấu trúc đích theo business-flow §1 / §3.1.2 / §5.3 trên Mongo thật:
 * - Mục đã viết luôn là "có": khung mẫu (dưới 20% mục có chữ) vẫn đọc mục đã viết, chỉ soạn mục còn trống (§5.3).
 * - Bỏ chữ giữ heading: vùng chỉ còn khung, chữ cũ không vào SRS và không đưa cho AI.
 * - Còn ít nhất một mục Bỏ chữ ⇒ không ra bản gốc 0.1, đi đường file còn thiếu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { makeDocx, p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { waitForExtraction } from "../../../src/modules/import/extract-jobs.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

/** Mọi prompt gửi cho AI trong test (lượt đọc nội dung, rà soát…). */
let prompts: string[] = []

beforeEach(() => {
  resetMockLlm()
  prompts = []
  mockOverrides.next = fakeMode1
  mockOverrides.before = (prompt) => {
    prompts.push(prompt)
  }
})

const WRITTEN_SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })

interface TextSection { key: string; title: string; level: number; dropped: boolean }

/** Tạo dự án (mặc định không tick "Bổ sung các mục còn thiếu") + upload file vào ô SRS. */
const upload = async (file: Buffer) => {
  const seeded = await seedFixture("minimal", { balance: 5000 })
  const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Cổng cấp phép", has_srs_file: true })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  const projectId = String(created.body.data._id)
  const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", file, "SRS.docx")
  expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)
  return { seeded, projectId, importId: String(uploaded.body.data.import.id) }
}

const view = async (seeded: SeededFixture, projectId: string) => (await request(app).get(`/api/v1/projects/${projectId}/import`).set(H(seeded))).body.data

/** Bắt đầu (viết lại file nếu có Bỏ chữ ⇒ đọc nội dung) ⇒ finalize (I-5). */
const startAndFinalize = async (seeded: SeededFixture, projectId: string, importId: string) => {
  const started = await request(app).post(`/api/v1/projects/${projectId}/import/extract`).set(H(seeded)).send({ import_id: importId, confirm_latest: true })
  expect(started.status, JSON.stringify(started.body.error)).toBe(200)
  await waitForExtraction(importId)
  await startFinalize(projectId, seeded.userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version })
  await waitForFinalize(importId)
  return (await ImportedDocument.findById(importId))!
}

const CHAPTER_1 = "Cổng cấp phép xây dựng trực tuyến cho phép người dân nộp hồ sơ xin phép xây dựng và theo dõi tiến độ xử lý."

/** Mẫu Sở (§5.3): 6 chương, PO đã viết Chương 1, các chương khác chỉ còn chữ hướng dẫn. */
const soXdTemplate = () =>
  makeDocx({
    styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style>`,
    body:
      p("Tài liệu đặc tả yêu cầu phần mềm") +
      styled("u1", "1 Giới thiệu") +
      p(CHAPTER_1) +
      p("Hệ thống phục vụ Sở Xây dựng và người dân trên toàn tỉnh, thay cho việc nộp hồ sơ giấy tại bộ phận một cửa.") +
      styled("u1", "2 Quy trình nghiệp vụ") +
      p("[Mục này mô tả các quy trình nghiệp vụ chính.]") +
      styled("u1", "3 Tác nhân") +
      p("[Mục này mô tả các tác nhân của hệ thống.]") +
      styled("u1", "4 Hồ sơ cấp phép") +
      p("[Mục này mô tả các loại hồ sơ.]") +
      styled("u1", "5 Thuật ngữ") +
      p("[Mục này liệt kê các thuật ngữ.]") +
      styled("u1", "6 Dự toán kinh phí") +
      p("[Mục này ghi dự toán kinh phí.]")
  })

describe("FLF-463 - mục đã viết là \"có\", Bỏ chữ giữ heading, Bỏ chữ không ra 0.1", () => {
  it("§5.3: file 1/6 mục đã viết (nhãn Khung mẫu) ⇒ chương đã viết là \"có\" và được đọc, chỉ soạn 5 mục còn lại; không có 0.1", async () => {
    const { seeded, projectId, importId } = await upload(await soXdTemplate())
    const preview = (await view(seeded, projectId)).structure_preview
    // Ngưỡng 20% chỉ gắn nhãn câu tóm tắt
    expect(preview.summary).toMatchObject({ kind: "template", present: 1, missing: 5 })
    expect(preview.intent).toBe("fixed")

    const doc = await startAndFinalize(seeded, projectId, importId)
    // Chương 1 được đọc như SRS đã viết (không bỏ qua vì nhãn Khung mẫu)
    expect(prompts.some((pr) => pr.includes(CHAPTER_1))).toBe(true)

    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const structure = profile.target_structure!
    expect(structure).toMatchObject({ target: "template", intent: "fixed", resolved_mode: 3 })
    const present = structure.sections.filter((s) => s.status === "present")
    expect(present.map((s) => s.title)).toEqual(["1 Giới thiệu"])
    expect(structure.missing).toHaveLength(5)
    // Ngữ cảnh mẫu cho Luồng 2 chỉ có mục còn trống — chương đã viết không bị soạn lại
    const contextIds = (profile.template_context ?? []).map((e) => e.section_id)
    expect(contextIds).not.toContain(present[0]!.section_id)
    expect(doc.status).toBe("drafting")
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
  }, 120000)

  it("file đủ cấu trúc + Bỏ chữ một mục ⇒ heading còn, chữ cũ không vào SRS / không gửi AI, mục đó còn trống, không có 0.1", async () => {
    const { seeded, projectId, importId } = await upload(await readFile(WRITTEN_SRS))
    const before = await view(seeded, projectId)
    expect(before.structure_preview.summary).toMatchObject({ kind: "written", missing: 0 })
    const actors = (before.text_sections as TextSection[]).find((s) => s.title.includes("Actors"))!
    expect(actors).toBeTruthy()

    // Chữ cũ dưới vùng Actors (tới heading cùng cấp / cấp trên kế tiếp)
    const blocks = await DocBlock.find({ projectId }).sort({ "anchor.ordinal": 1 }).lean()
    const start = blocks.findIndex((b) => b.block_id === actors.key)
    const level = blocks[start]!.level ?? 1
    const oldTexts: string[] = []
    for (const b of blocks.slice(start + 1)) {
      if (b.kind === "heading" && (b.level ?? 1) <= level) break
      if (b.kind === "paragraph" && b.text.trim().length > 30 && !b.text.includes("[")) oldTexts.push(b.text.trim())
      if (b.kind === "table_cell" && b.text.trim().length > 30) oldTexts.push(b.text.trim())
    }
    expect(oldTexts.length).toBeGreaterThan(0)

    const dropped = await request(app).patch(`/api/v1/projects/${projectId}/import/drop-text`).set(H(seeded)).send({ import_id: importId, keys: [actors.key] })
    expect(dropped.status, JSON.stringify(dropped.body.error)).toBe(200)
    const doc = await startAndFinalize(seeded, projectId, importId)

    // Giữ heading: heading của vùng còn trong file đã viết lại
    const after = await DocBlock.find({ projectId }).lean()
    expect(after.some((b) => b.kind === "heading" && b.text.trim() === actors.title)).toBe(true)
    // Chữ cũ không vào SRS, không đưa cho AI
    const texts = after.map((b) => b.text.trim())
    for (const old of oldTexts) {
      expect(texts).not.toContain(old)
      expect(prompts.some((pr) => pr.includes(old))).toBe(false)
    }

    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const structure = profile.target_structure!
    const headingSection = profile.heading_map.find((h) => h.block_id === actors.key)!.section_id
    expect(structure.missing).toContain(headingSection)
    expect(structure.resolved_mode).toBe(3)
    // Còn mục Bỏ chữ ⇒ không có bản gốc 0.1, đi đường file còn thiếu
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect(doc.status).toBe("drafting")
  }, 120000)
})
