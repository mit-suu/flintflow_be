/**
 * Business-flow §3.6 "File trông như SRS" trên Mongo thật: `POST /projects/precheck-docx` (hộp Tạo dự án) và `precheck` kèm
 * `POST /projects/:id/documents` (đính kèm trong dự án) — Code nhận diện, không gọi AI, không lưu file ở endpoint precheck.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file"),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))
import { readFile } from "node:fs/promises"
import request from "supertest"
import app from "../../../src/app.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { makeDocx, p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { DocxPackage, writeStamp } from "../../../src/modules/docx-ooxml/index.js"
import { ProjectDocument } from "../../../src/modules/project/project-document.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const SRS = new URL("../../../fixtures/existing-srs-fu-student-portal.docx", import.meta.url)
const H = (s: SeededFixture) => ({ Authorization: `Bearer ${s.token}` })
const MINUTES = () =>
  makeDocx({
    styles: `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/></w:style>`,
    body:
      styled("u1", "Biên bản họp kick-off") +
      p("Thời gian: 9h sáng thứ hai, phòng họp tầng 3.") +
      p("Thành phần: anh Nam (khách hàng), chị Lan (PM), nhóm phát triển.") +
      p("Nội dung: thống nhất lịch giao hàng đợt một vào cuối tháng, khách gửi logo trước thứ sáu.")
  })

const precheck = (seeded: SeededFixture, buffer: Buffer, name: string) =>
  request(app).post("/api/v1/projects/precheck-docx").set(H(seeded)).attach("file", buffer, name)

describe("precheck-docx — hộp Tạo dự án", () => {
  it("SRS ⇒ looks_like_srs; biên bản họp .docx ⇒ false; file không phải .docx ⇒ false; không lưu file", async () => {
    const seeded = await seedFixture("minimal")
    const srs = await precheck(seeded, await readFile(SRS), "SRS cu.docx")
    expect(srs.status, JSON.stringify(srs.body.error)).toBe(200)
    expect(srs.body.data).toEqual({ looks_like_srs: true, stamp: null })

    const minutes = await precheck(seeded, await MINUTES(), "Bien ban hop.docx")
    expect(minutes.body.data).toEqual({ looks_like_srs: false, stamp: null })

    const pdf = await precheck(seeded, Buffer.from("%PDF-1.4 fake"), "Ghi chu.pdf")
    expect(pdf.body.data).toEqual({ looks_like_srs: false, stamp: null })
    expect(await ProjectDocument.countDocuments({})).toBe(0)
  })

  it("file tải về từ một dự án (có dấu version) ⇒ stamp đúng dự án", async () => {
    const seeded = await seedFixture("minimal")
    const pkg = await DocxPackage.load(await readFile(SRS))
    await writeStamp(pkg, { project_id: seeded.projectId, version: "1.0", source: "baseline" })
    const res = await precheck(seeded, await pkg.toBuffer(), "SRS_v1.0.docx")
    expect(res.body.data).toEqual({ looks_like_srs: true, stamp: { project_id: seeded.projectId } })
  })

  it("thiếu file ⇒ 400 FILE_REQUIRED", async () => {
    const seeded = await seedFixture("minimal")
    const res = await request(app).post("/api/v1/projects/precheck-docx").set(H(seeded))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("FILE_REQUIRED")
  })
})

describe("precheck kèm tài liệu đính kèm trong dự án", () => {
  it("dự án đã có SRS: đính kèm bản SRS khác ⇒ precheck có heading_overlap cao; biên bản họp ⇒ không phải SRS", async () => {
    const seeded = await seedFixture("minimal", { balance: 1000 })
    const created = await request(app).post("/api/v1/projects").set(H(seeded)).send({ name: "Portal", has_srs_file: true })
    const projectId = String(created.body.data._id)
    const uploaded = await request(app).post(`/api/v1/projects/${projectId}/import`).set(H(seeded)).attach("file", await readFile(SRS), "SRS.docx")
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201)

    const again = await request(app).post(`/api/v1/projects/${projectId}/documents`).set(H(seeded)).attach("file", await readFile(SRS), "SRS ban moi.docx")
    expect(again.status, JSON.stringify(again.body.error)).toBe(201)
    expect(again.body.data.precheck).toMatchObject({ looks_like_srs: true, stamp: null })
    expect(again.body.data.precheck.heading_overlap).toBeGreaterThan(0.9)
    expect(again.body.data.originalName).toBe("SRS ban moi.docx")

    const minutes = await request(app).post(`/api/v1/projects/${projectId}/documents`).set(H(seeded)).attach("file", await MINUTES(), "Bien ban.docx")
    expect(minutes.body.data.precheck).toEqual({ looks_like_srs: false, stamp: null })
  })
})
