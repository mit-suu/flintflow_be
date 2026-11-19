/**
 * FLF-443 - đọc tài liệu tham khảo: chữ chia đoạn (`GET /documents/:docId/text`), tải file gốc
 * (`GET /documents/:docId/download`) và danh sách tài liệu không lộ URL kho / chữ đã trích.
 * Cloudinary upload được thay bằng bản giả; tải file gốc đi qua `fetch` toàn cục được giả (supertest dùng http nên không đụng).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import request from "supertest"
import mongoose from "mongoose"
import { v2 as cloudinary } from "cloudinary"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file"),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))

import app from "../../src/app.js"
import { ProjectDocument } from "../../src/modules/project/project-document.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { captureSources } from "../../src/modules/project/requirement-source.service.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import type { Spine } from "../../src/modules/spine/spine.types.js"
import { referenceDocumentTextSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const projectUrl = (projectId: string, suffix = "") => "/api/v1/projects/" + projectId + suffix

const MINUTES = "Biên bản họp kick-off\n\nKhách hàng, người bán và admin dùng hệ thống.\n\nTrang thanh toán phải xong trong 3 giây."

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

/** Tài liệu đã lưu sẵn (không qua upload) - để dựng đủ đuôi file / khoá kho mà test cần. */
const storedDocument = (overrides: Record<string, unknown> = {}) =>
  ProjectDocument.create({
    projectId: seeded.projectId,
    uploadedBy: seeded.userId,
    fileName: "flintflow/projects/p/brief",
    originalName: "brief.pdf",
    mimeType: "application/pdf",
    size: 4,
    cloudinaryPublicId: "flintflow/projects/p/brief.pdf",
    url: "https://example.test/brief.pdf",
    extension: ".pdf",
    extractedText: "Đoạn một.\n\nĐoạn hai.",
    docCode: 7,
    parseStatus: "success",
    summaryStatus: "pending",
    ...overrides
  })

const binaryParser = (res: request.Response, callback: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = []
  res.on("data", (chunk: Buffer) => chunks.push(chunk))
  res.on("end", () => callback(null, Buffer.concat(chunks)))
}

const download = (docId: string, token = seeded.token) =>
  request(app).get(projectUrl(seeded.projectId, `/documents/${docId}/download`)).set(bearer(token)).buffer(true).parse(binaryParser)

beforeAll(() => {
  cloudinary.config({ cloud_name: "demo-cloud", api_key: "k", api_secret: "s" })
})

beforeEach(async () => {
  seeded = await seedFixture("full")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /documents/:docId/text", () => {
  it("mọi para_id của GET /sources đều có trong text, đúng chữ; kết quả hợp khuôn referenceDocumentTextSchema", async () => {
    expect((await upload(MINUTES, "minutes.txt")).status).toBe(201)
    const doc = await ProjectDocument.findOne({ projectId: seeded.projectId }).lean()
    await captureSources(seeded.projectId, "S-6.4", await spineOf(), [{ path: "nfrs[id=N03]", paras: ["D1-P03", "D1-P02"] }])

    const sources = await request(app).get(projectUrl(seeded.projectId, "/sources")).set(bearer(seeded.token))
    const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${doc!._id}/text`)).set(bearer(seeded.token))

    expect(res.status).toBe(200)
    const body = referenceDocumentTextSchema.parse(res.body.data)
    expect(body).toMatchObject({ id: String(doc!._id), name: "minutes.txt" })
    expect(body.paragraphs.map((p) => p.para_id)).toEqual(["D1-P01", "D1-P02", "D1-P03"])
    const byId = new Map(body.paragraphs.map((p) => [p.para_id, p.text]))
    for (const ref of sources.body.data.sources.flatMap((s: { refs: Array<{ para_id: string; quote: string }> }) => s.refs)) {
      expect(byId.get(ref.para_id), ref.para_id).toBe(ref.quote)
    }
  })

  it("bản đã bị thay (supersededBy) cùng project vẫn đọc được", async () => {
    const doc = await storedDocument({ supersededBy: new mongoose.Types.ObjectId(), supersededAt: new Date() })
    const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${doc._id}/text`)).set(bearer(seeded.token))
    expect(res.status).toBe(200)
    expect(res.body.data.paragraphs).toEqual([
      { para_id: "D7-P01", text: "Đoạn một." },
      { para_id: "D7-P02", text: "Đoạn hai." }
    ])
  })

  it("parse lỗi (không có chữ) ⇒ paragraphs rỗng", async () => {
    const doc = await storedDocument({ extractedText: null, parseStatus: "failed" })
    const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${doc._id}/text`)).set(bearer(seeded.token))
    expect(res.status).toBe(200)
    expect(res.body.data.paragraphs).toEqual([])
  })

  it("id rác ⇒ 404 DOCUMENT_NOT_FOUND", async () => {
    const res = await request(app).get(projectUrl(seeded.projectId, "/documents/not-an-object-id/text")).set(bearer(seeded.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("DOCUMENT_NOT_FOUND")
  })

  it("id đúng khuôn nhưng không có ⇒ 404 DOCUMENT_NOT_FOUND", async () => {
    const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${new mongoose.Types.ObjectId()}/text`)).set(bearer(seeded.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("DOCUMENT_NOT_FOUND")
  })

  it("tài liệu của dự án khác CÙNG org ⇒ 404 DOCUMENT_NOT_FOUND (không đọc chéo dự án)", async () => {
    const sibling = await Project.create({ userId: seeded.userId, organizationId: seeded.orgId, name: "Sibling" })
    const foreign = await ProjectDocument.create({
      projectId: sibling._id,
      uploadedBy: seeded.userId,
      fileName: "x",
      originalName: "secret.txt",
      mimeType: "text/plain",
      size: 1,
      cloudinaryPublicId: "x",
      url: "https://example.test/x",
      extension: ".txt",
      extractedText: "bí mật",
      docCode: 1,
      parseStatus: "success",
      summaryStatus: "pending"
    })
    for (const suffix of ["text", "download"]) {
      const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${foreign._id}/${suffix}`)).set(bearer(seeded.token))
      expect(res.status, suffix).toBe(404)
      expect(res.body.error.code, suffix).toBe("DOCUMENT_NOT_FOUND")
    }
  })

  it("org khác ⇒ 404 PROJECT_NOT_FOUND, kể cả với id tài liệu thật", async () => {
    const doc = await storedDocument()
    const other = await seedFixture("minimal")
    for (const suffix of ["text", "download"]) {
      const res = await request(app).get(projectUrl(seeded.projectId, `/documents/${doc._id}/${suffix}`)).set(bearer(other.token))
      expect(res.status, suffix).toBe(404)
      expect(res.body.error.code, suffix).toBe("PROJECT_NOT_FOUND")
    }
  })

  it("chưa đăng nhập ⇒ 401", async () => {
    const doc = await storedDocument()
    expect((await request(app).get(projectUrl(seeded.projectId, `/documents/${doc._id}/text`))).status).toBe(401)
  })
})

describe("GET /documents/:docId/download", () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10, 0x80])

  it("stream đúng byte, tên gốc tiếng Việt qua filename*, Content-Type theo đuôi, nosniff; URL dựng từ khoá lưu", async () => {
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }))
    vi.stubGlobal("fetch", fetchMock)
    const doc = await storedDocument({ originalName: "Biên bản họp (v2).pdf" })

    const res = await download(String(doc._id))

    expect(res.status).toBe(200)
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0)
    expect(res.headers["content-type"]).toBe("application/pdf")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    const disposition = res.headers["content-disposition"] as string
    expect(disposition.startsWith("attachment; filename*=UTF-8''")).toBe(true)
    expect(decodeURIComponent(disposition.slice("attachment; filename*=UTF-8''".length))).toBe("Biên bản họp (v2).pdf")
    // dùng khoá lưu (SDK dựng URL), không dùng `url` đã lưu
    const url = new URL((fetchMock.mock.calls[0] as unknown[])[0] as string)
    expect(url.host).toBe("res.cloudinary.com")
    expect(url.pathname).toContain("/raw/upload/")
    expect(url.pathname).toContain("flintflow/projects/p/brief.pdf")
  })

  it("upload tên tiếng Việt ⇒ lưu đúng UTF-8 và tải về đúng tên", async () => {
    const up = await upload(MINUTES, "Biên bản họp.txt")
    expect(up.status).toBe(201)
    const doc = await ProjectDocument.findOne({ projectId: seeded.projectId }).lean()
    expect(doc!.originalName).toBe("Biên bản họp.txt")

    vi.stubGlobal("fetch", vi.fn(async () => new Response(MINUTES, { status: 200 })))
    const res = await download(String(doc!._id))
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8")
    expect(decodeURIComponent((res.headers["content-disposition"] as string).split("''")[1])).toBe("Biên bản họp.txt")
    expect((res.body as Buffer).toString("utf8")).toBe(MINUTES)
  })

  it.each([
    [".pdf", "application/pdf"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".doc", "application/msword"],
    [".md", "text/markdown; charset=utf-8"],
    [".txt", "text/plain; charset=utf-8"],
    [".html", "application/octet-stream"],
    [".svg", "application/octet-stream"]
  ])("Content-Type của đuôi %s là %s", async (extension, contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200 })))
    const doc = await storedDocument({ extension, originalName: "file" + extension })
    const res = await download(String(doc._id))
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe(contentType)
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
  })

  it("kho trả 404 ⇒ 503 DOCUMENT_UNAVAILABLE, không có header tải về", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })))
    const doc = await storedDocument()
    const res = await download(String(doc._id))
    expect(res.status).toBe(503)
    expect(res.headers["content-disposition"]).toBeUndefined()
    expect(JSON.parse((res.body as Buffer).toString("utf8")).error.code).toBe("DOCUMENT_UNAVAILABLE")
  })

  it("kho quá thời gian (AbortError) ⇒ 503 DOCUMENT_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }) }))
    const doc = await storedDocument()
    const res = await download(String(doc._id))
    expect(res.status).toBe(503)
    expect(JSON.parse((res.body as Buffer).toString("utf8")).error.code).toBe("DOCUMENT_UNAVAILABLE")
  })

  it("kho báo file vượt 10 MB ⇒ 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024 + 1) } })))
    const doc = await storedDocument()
    expect((await download(String(doc._id))).status).toBe(503)
  })
})

describe("GET /documents", () => {
  it("không còn trả url, cloudinaryPublicId, fileName, extractedText (cả response upload); vẫn trả các field FE dùng", async () => {
    const uploaded = await upload(MINUTES, "minutes.txt")
    expect(uploaded.status).toBe(201)
    for (const field of ["url", "cloudinaryPublicId", "fileName", "extractedText"]) expect(uploaded.body.data, field).not.toHaveProperty(field)

    const res = await request(app).get(projectUrl(seeded.projectId, "/documents")).set(bearer(seeded.token))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    const item = res.body.data[0]
    for (const field of ["url", "cloudinaryPublicId", "fileName", "extractedText"]) expect(item, field).not.toHaveProperty(field)
    expect(item).toMatchObject({ originalName: "minutes.txt", docCode: 1, parseStatus: "success", extension: ".txt", replaces: [] })
    expect(typeof item._id).toBe("string")
  })
})
