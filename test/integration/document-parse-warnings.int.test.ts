/**
 * FLF-449 việc 27 + lỗi L3 - cảnh báo khi trích chữ tài liệu tham khảo: PDF không có lớp chữ (bản scan) không còn được đánh
 * `parseStatus: "success"` (trước đây chỉ lộ ra lúc rút yêu cầu, 422), ảnh trong .docx bị bỏ thì ghi `parseWarnings`, và
 * `GET /documents` trả `parseWarnings` cho FE hiện trên dòng tài liệu. Cloudinary / provider AI là bản giả.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"
import mongoose from "mongoose"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file") + "-" + Math.random().toString(36).slice(2),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))
vi.mock("../../src/modules/project/project-document.storage.js", () => ({ destroyDocumentAsset: vi.fn(async () => undefined) }))

import app from "../../src/app.js"
import { ProjectDocument } from "../../src/modules/project/project-document.model.js"
import { mockCalls, resetMockLlm } from "../helpers/mock-llm.js"
import { DOCX_MIME, docxBuffer, minimalPdf } from "../helpers/file-fixtures.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const url = (suffix = "") => "/api/v1/projects/" + seeded.projectId + "/documents" + suffix

let seeded: SeededFixture

const upload = (buffer: Buffer, filename: string, contentType: string) =>
  request(app).post(url()).set(bearer(seeded.token)).attach("file", buffer, { filename, contentType })

const listed = async () => {
  const res = await request(app).get(url()).set(bearer(seeded.token))
  expect(res.status).toBe(200)
  return res.body.data as { originalName: string; parseStatus: string; parseWarnings?: string[]; extractedText?: unknown }[]
}

beforeEach(async () => {
  seeded = await seedFixture("full")
  resetMockLlm()
})

describe("FLF-449 L3 - PDF không có lớp chữ", () => {
  it("PDF scan ⇒ 201 nhưng failed + pdf_no_text, không chunk / không gọi AI tóm tắt, không tính token", async () => {
    const res = await upload(minimalPdf(["", ""]), "ban-scan.pdf", "application/pdf")
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ parseStatus: "failed", parseWarnings: ["pdf_no_text"], summaryStatus: "pending", tokenCount: null })
    expect(res.body.data.parseError).toContain(".docx")
    expect(mockCalls).toHaveLength(0)

    const saved = await ProjectDocument.findById(res.body.data._id).lean()
    expect(saved?.extractedText).toBeNull()

    const [doc] = await listed()
    expect(doc).toMatchObject({ originalName: "ban-scan.pdf", parseStatus: "failed", parseWarnings: ["pdf_no_text"] })
    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.meta.tokens_used).toBe(0)
  })

  it("PDF có chữ ⇒ success, không cảnh báo", async () => {
    const res = await upload(minimalPdf(["Customer needs order approval within one business day."]), "bien-ban.pdf", "application/pdf")
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ parseStatus: "success", parseWarnings: [] })
    const saved = await ProjectDocument.findById(res.body.data._id).lean()
    expect(saved?.extractedText).toContain("order approval")
  })
})

describe("FLF-449 việc 27 - ảnh trong .docx", () => {
  it(".docx có ảnh ⇒ success + images_skipped, trả trong GET /documents (không lộ extractedText)", async () => {
    const res = await upload(await docxBuffer("Email khách: cần xuất báo cáo hằng tuần.", true), "email.docx", DOCX_MIME)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ parseStatus: "success", parseWarnings: ["images_skipped"] })

    const [doc] = await listed()
    expect(doc.parseWarnings).toEqual(["images_skipped"])
    expect(doc).not.toHaveProperty("extractedText")
  })

  it(".doc Word 97-2003 ⇒ failed, lý do rõ (lưu lại thành .docx)", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.from("Word.Document payload")])
    const res = await upload(ole, "yeu-cau-cu.doc", "application/msword")
    expect(res.status).toBe(201)
    expect(res.body.data.parseStatus).toBe("failed")
    expect(res.body.data.parseError).toMatch(/Word 97-2003.*\.docx/)
  })

  it("tài liệu tải trước FLF-449 (không có field) ⇒ parseWarnings []", async () => {
    await ProjectDocument.collection.insertOne({
      projectId: new mongoose.Types.ObjectId(seeded.projectId),
      uploadedBy: new mongoose.Types.ObjectId(seeded.userId),
      fileName: "legacy",
      originalName: "legacy.txt",
      mimeType: "text/plain",
      size: 3,
      cloudinaryPublicId: "legacy",
      url: "https://example.test/legacy",
      extractedText: "cũ",
      parseStatus: "success",
      summaryStatus: "success",
      supersededBy: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    const [doc] = await listed()
    expect(doc).toMatchObject({ originalName: "legacy.txt", parseWarnings: [] })
  })
})
