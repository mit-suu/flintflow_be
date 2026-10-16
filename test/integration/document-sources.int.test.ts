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

describe("FLF-292 — mã đoạn và nguồn của yêu cầu", () => {
  it("mỗi tài liệu nhận số riêng theo thứ tự upload; prompt Draft mang mã đoạn", async () => {
    expect((await upload(MINUTES, "minutes.txt")).status).toBe(201)
    expect((await upload(EMAIL, "email.txt")).status).toBe(201)

    const docs = await ProjectDocument.find({ projectId: seeded.projectId }).sort({ docCode: 1 }).lean()
    expect(docs.map((d) => [d.originalName, d.docCode])).toEqual([
      ["minutes.txt", 1],
      ["email.txt", 2]
    ])

    const ctx = await buildDocumentContext(seeded.projectId, ActionType.DRAFT, "S-6.4")
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
    await buildDocumentContext(seeded.projectId, ActionType.DRAFT, "S-6.4")
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

  it("org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await request(app).get(projectUrl(seeded.projectId, "/sources")).set(bearer(other.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})
