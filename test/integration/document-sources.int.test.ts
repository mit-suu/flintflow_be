/**
 * FLF-292 — tài liệu upload ⇒ mã đoạn trong prompt ⇒ nguồn của yêu cầu, qua HTTP thật trên Mongo in-memory.
 * Lượt gọi model được thay bằng `captureSources` với đúng khuôn `sources` model trả; phần tra mã đoạn, lưu và đọc là code thật.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file"),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))

import app from "../../src/app.js"
import { ProjectDocument } from "../../src/modules/project/project-document.model.js"
import { ProjectDocumentChunk } from "../../src/modules/project/project-document-chunk.model.js"
import { env } from "../../src/config/env.js"
import { captureSources } from "../../src/modules/project/requirement-source.service.js"
import { buildDocumentContext } from "../../src/shared/ai/document-context.service.js"
import { ActionType } from "../../src/shared/ai/ai-action.types.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import type { Spine } from "../../src/modules/spine/spine.types.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const projectUrl = (projectId: string, suffix = "") => "/api/v1/projects/" + projectId + suffix

const MINUTES = "Biên bản họp kick-off\n\nKhách hàng, người bán và admin dùng hệ thống.\n\nTrang thanh toán phải xong trong 3 giây."
const EMAIL = "Email khách hàng\n\nChỉ nhận thanh toán online, không COD."

let seeded: SeededFixture

const upload = (text: string, filename: string) =>
  request(app)
    .post(projectUrl(seeded.projectId, "/documents"))
    .set(bearer(seeded.token))
    .attach("file", Buffer.from(text), { filename, contentType: "text/plain" })

const spineOf = async (): Promise<Spine> => {
  const record = await spineRepository.get(seeded.projectId)
  const { projectId: _projectId, ...spine } = record!
  return spine
}

beforeEach(async () => {
  seeded = await seedFixture("full")
})

describe("FLF-292 - mã đoạn và nguồn của yêu cầu", () => {
  it("mỗi tài liệu nhận số riêng theo thứ tự upload; prompt Draft mang mã đoạn", async () => {
    expect((await upload(MINUTES, "minutes.txt")).status).toBe(201)
    expect((await upload(EMAIL, "email.txt")).status).toBe(201)

    const docs = await ProjectDocument.find({ projectId: seeded.projectId }).sort({ docCode: 1 }).lean()
    expect(docs.map((d) => [d.originalName, d.docCode])).toEqual([
      ["minutes.txt", 1],
      ["email.txt", 2]
    ])

    const ctx = await buildDocumentContext({ projectId: seeded.projectId, actionType: ActionType.DRAFT, stepId: "S-6.4" })
    expect(ctx.contextText).toContain("mã tài liệu: D1")
    expect(ctx.contextText).toContain("[D1-P03] Trang thanh toán phải xong trong 3 giây.")
    expect(ctx.contextText).toContain("[D2-P02] Chỉ nhận thanh toán online, không COD.")
  })

  it("tài liệu upload trước FLF-292 (chưa có số) được gán bù, nối sau số lớn nhất", async () => {
    await upload(MINUTES, "minutes.txt")
    const legacy = await ProjectDocument.create({
      projectId: seeded.projectId,
      uploadedBy: seeded.userId,
      fileName: "legacy",
      originalName: "legacy.txt",
      mimeType: "text/plain",
      size: 10,
      cloudinaryPublicId: "legacy",
      url: "https://example.test/legacy",
      extractedText: "Ghi chú cũ",
      parseStatus: "success",
      summaryStatus: "pending"
    })
    await buildDocumentContext({ projectId: seeded.projectId, actionType: ActionType.DRAFT, stepId: "S-6.4" })
    expect((await ProjectDocument.findById(legacy._id).lean())?.docCode).toBe(2)
  })

  it("nguồn hợp lệ được lưu và trả qua GET /sources; mã bịa và phần tử không có bị bỏ", async () => {
    await upload(MINUTES, "minutes.txt")
    const saved = await captureSources(seeded.projectId, "S-6.4", await spineOf(), [
      { path: "nfrs[id=N03].threshold", paras: ["D1-P03", "D1-P42"] },
      { path: "nfrs[id=N999]", paras: ["D1-P03"] }
    ])
    expect(saved).toBe(1)

    const res = await request(app).get(projectUrl(seeded.projectId, "/sources")).set(bearer(seeded.token))
    expect(res.status).toBe(200)
    expect(res.body.data.sources).toHaveLength(1)
    expect(res.body.data.sources[0]).toMatchObject({
      path: "nfrs[id=N03]",
      step_id: "S-6.4",
      refs: [{ para_id: "D1-P03", document_name: "minutes.txt", quote: "Trang thanh toán phải xong trong 3 giây." }]
    })
  })

  it("lượt Draft sau của cùng phần tử ghi đè nguồn cũ", async () => {
    await upload(MINUTES, "minutes.txt")
    await captureSources(seeded.projectId, "S-6.4", await spineOf(), [{ path: "nfrs[id=N03]", paras: ["D1-P03"] }])
    await captureSources(seeded.projectId, "S-6.4", await spineOf(), [{ path: "nfrs[id=N03]", paras: ["D1-P02"] }])
    const res = await request(app).get(projectUrl(seeded.projectId, "/sources")).set(bearer(seeded.token))
    expect(res.body.data.sources.map((s: { refs: Array<{ para_id: string }> }) => s.refs.map((r) => r.para_id))).toEqual([["D1-P02"]])
  })

  it("FLF-393: SRS lớn ⇒ chunk lưu lúc upload, chat chỉ nhận đoạn liên quan dưới trần, xoá tài liệu xoá chunk", async () => {
    const useCase = (n: number) =>
      [`UC-${String(n).padStart(2, "0")} ${n === 42 ? "Hoàn tiền khi huỷ lịch" : `Chức năng số ${n}`}`, ...Array.from({ length: 6 }, (_, i) => `Bước ${i + 1}: hệ thống kiểm tra dữ liệu của chức năng ${n}, ghi nhận kết quả và thông báo cho người dùng liên quan.`)].join("\n\n")
    const srs = ["1 Giới thiệu", "Đặc tả hệ thống đặt lịch khám.", "2 Use Cases", ...Array.from({ length: 150 }, (_, i) => useCase(i + 1))].join("\n\n")

    const res = await upload(srs, "srs.txt")
    expect(res.status).toBe(201)
    const documentId = String(res.body.data?._id ?? (await ProjectDocument.findOne({ projectId: seeded.projectId }).lean())!._id)
    const chunkCount = await ProjectDocumentChunk.countDocuments({ documentId })
    expect(chunkCount).toBeGreaterThan(20)

    const ctx = await buildDocumentContext({ projectId: seeded.projectId, actionType: ActionType.CHAT, query: "uc-42 hoan tien" })
    expect(ctx.mode).toBe("retrieved")
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_CHAT_TOKENS)
    expect(ctx.fullTokens).toBeGreaterThan(env.DOC_CONTEXT_CHAT_TOKENS)
    expect(ctx.contextText).toContain("UC-42 Hoàn tiền khi huỷ lịch")
    expect(ctx.contextText).toMatch(/\[D1-P\d+\] UC-42 Hoàn tiền khi huỷ lịch/)

    // Step không đọc `documents` vẫn không nạp gì
    expect((await buildDocumentContext({ projectId: seeded.projectId, actionType: ActionType.DRAFT, stepId: "S-3.4" })).contextText).toBe("")

    const del = await request(app).delete(projectUrl(seeded.projectId, "/documents/" + documentId)).set(bearer(seeded.token))
    expect(del.status).toBeLessThan(300)
    expect(await ProjectDocumentChunk.countDocuments({ documentId })).toBe(0)
  })

  it("org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await request(app).get(projectUrl(seeded.projectId, "/sources")).set(bearer(other.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})
