/**
 * pdf-export (FLF-316) — endpoint 34 `GET /projects/:id/export/pdf` qua HTTP trên Mongo thật.
 * Converter bị mock: test không có Gotenberg (`test/setup.ts` trỏ cổng đóng). Ca "Gotenberg chết" gọi
 * đúng client thật vào cổng đóng đó ⇒ 503, và xuất Word ngay sau vẫn chạy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { readFixtureJson, authAs, seedFixture, type SeededFixture } from "../setup.js"
import { gridFsDiagramStore } from "../../src/modules/diagram/diagram-file.store.js"
import { baselineResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"

const { mockConvert, realConvert } = vi.hoisted(() => ({
  mockConvert: vi.fn(),
  realConvert: { fn: null as null | ((docx: Buffer, fileName: string) => Promise<Buffer>) }
}))

vi.mock("../../src/shared/pdf/gotenberg.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/pdf/gotenberg.client.js")>()
  realConvert.fn = actual.docxToPdf
  return { ...actual, docxToPdf: mockConvert }
})

/** PDF giả đủ chữ ký `%PDF-` — route không đọc nội dung, chỉ chuyển tiếp. */
const FAKE_PDF = Buffer.from("%PDF-1.7\n% fake\n%%EOF\n")

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

const seedDiagramPngs = async (seeded: SeededFixture): Promise<void> => {
  const spine = readFixtureJson<{ diagrams: Array<{ id: string; render_status: string }> }>("spine-fixture-19-screens.json")
  for (const d of spine.diagrams.filter((x) => x.render_status === "ok")) {
    await gridFsDiagramStore.save(seeded.projectId, d.id, "png", { data: PNG_1X1, contentType: "image/png" })
  }
}

const download = (projectId: string, token: string, suffix: string) =>
  request(app)
    .get(`/api/v1/projects/${projectId}${suffix}`)
    .set({ Authorization: `Bearer ${token}` })
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => done(null, Buffer.concat(chunks)))
    })

/** Body lỗi bị parser nhị phân giữ dạng Buffer — đọc lại envelope JSON. */
const errorCode = (res: { body: unknown }): string =>
  (JSON.parse((res.body as Buffer).toString("utf8")) as { error: { code: string } }).error.code

beforeEach(() => {
  mockConvert.mockReset().mockResolvedValue(FAKE_PDF)
})

describe("GET /export/pdf", () => {
  it("draft: PDF từ chính buffer .docx của export Word, cùng header, tên file đổi đuôi", async () => {
    const seeded = await seedFixture("minimal")

    const pdf = await download(seeded.projectId, seeded.token, "/export/pdf?source=draft")
    expect(pdf.status).toBe(200)
    expect(pdf.headers["content-type"]).toBe("application/pdf")
    expect(pdf.body as Buffer).toEqual(FAKE_PDF)
    expect(pdf.headers["content-length"]).toBe(String(FAKE_PDF.length))
    expect(pdf.headers["x-document-language"]).toMatch(/^(vi|en)$/)
    expect(pdf.headers["x-spine-version"]).toBeDefined()
    expect(pdf.headers["x-assembled-at-version"]).toBeDefined()

    // Converter nhận đúng một file .docx (zip "PK") và tên file Word
    expect(mockConvert).toHaveBeenCalledTimes(1)
    const [docx, docxName] = mockConvert.mock.calls[0] as [Buffer, string]
    expect(docx.subarray(0, 2).toString()).toBe("PK")
    expect(docxName).toMatch(/-draft\.docx$/)

    const word = await download(seeded.projectId, seeded.token, "/export/word?source=draft")
    expect(word.status).toBe(200)
    const wordName = /filename="([^"]+)"/.exec(word.headers["content-disposition"])?.[1]
    const pdfName = /filename="([^"]+)"/.exec(pdf.headers["content-disposition"])?.[1]
    expect(wordName).toBe(docxName)
    expect(pdfName).toBe(docxName.replace(/\.docx$/, ".pdf"))
    expect(pdf.headers["x-document-language"]).toBe(word.headers["x-document-language"])
  })

  it("baseline: xuất được theo mã BLnnn, không kèm header độ mới của draft", async () => {
    const seeded = await seedFixture("full")
    await seedDiagramPngs(seeded)
    const created = await request(app)
      .post(`/api/v1/projects/${seeded.projectId}/baseline`)
      .set({ Authorization: `Bearer ${seeded.token}` })
      .send({ base_version: seeded.spineVersion })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const baseline = baselineResponseSchema.parse(created.body.data)

    const pdf = await download(seeded.projectId, seeded.token, `/export/pdf?source=baseline&baseline_id=${baseline.id}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers["content-disposition"]).toMatch(/-v1\.0\.pdf"$/)
    expect(pdf.headers["x-spine-version"]).toBeUndefined()
  })

  it("baseline không tồn tại ⇒ 404 BASELINE_NOT_FOUND, không gọi converter", async () => {
    const seeded = await seedFixture("minimal")
    const res = await download(seeded.projectId, seeded.token, "/export/pdf?source=baseline&baseline_id=BL999")
    expect(res.status).toBe(404)
    expect(errorCode(res)).toBe("BASELINE_NOT_FOUND")
    expect(mockConvert).not.toHaveBeenCalled()
  })

  it("query sai ⇒ 400 VALIDATION_ERROR như export Word", async () => {
    const seeded = await seedFixture("minimal")
    const res = await download(seeded.projectId, seeded.token, "/export/pdf?source=nope")
    expect(res.status).toBe(400)
    expect(errorCode(res)).toBe("VALIDATION_ERROR")
  })

  it("Viewer xuất được (endpoint chỉ đọc); người ngoài org nhận 404", async () => {
    const owner = await seedFixture("minimal")
    const viewer = await User.create({ email: "viewer@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: owner.orgId, userId: viewer._id, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: "viewer@flintflow.test", orgId: owner.orgId })

    expect((await download(owner.projectId, viewerToken, "/export/pdf?source=draft")).status).toBe(200)

    const stranger = await seedFixture("minimal")
    const res = await download(owner.projectId, stranger.token, "/export/pdf?source=draft")
    expect(res.status).toBe(404)
    expect(errorCode(res)).toBe("PROJECT_NOT_FOUND")
  })

  it("Gotenberg không chạy ⇒ 503 PDF_EXPORT_UNAVAILABLE có câu cho user; xuất Word vẫn chạy", async () => {
    mockConvert.mockImplementation((docx: Buffer, fileName: string) => realConvert.fn!(docx, fileName))
    const seeded = await seedFixture("minimal")

    const res = await download(seeded.projectId, seeded.token, "/export/pdf?source=draft")
    expect(res.status).toBe(503)
    const body = JSON.parse((res.body as Buffer).toString("utf8")) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("PDF_EXPORT_UNAVAILABLE")
    expect(body.error.message).toContain("PDF")
    // Câu cho user không lộ địa chỉ nội bộ của converter
    expect(body.error.message).not.toContain("127.0.0.1")

    const word = await download(seeded.projectId, seeded.token, "/export/word?source=draft")
    expect(word.status).toBe(200)
  })

  it("chưa đăng nhập ⇒ 401", async () => {
    const seeded = await seedFixture("minimal")
    const res = await request(app).get(`/api/v1/projects/${seeded.projectId}/export/pdf`)
    expect(res.status).toBe(401)
  })
})
