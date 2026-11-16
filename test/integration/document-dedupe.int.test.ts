/**
 * FLF-398 — tài liệu tham khảo: tải trùng hệt bị chặn, bản mới (cùng tên gốc / nội dung giống) được hỏi thay bản cũ hay giữ cả
 * hai. Qua HTTP thật trên Mongo in-memory; Cloudinary và provider AI là bản giả.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file") + "-" + Math.random().toString(36).slice(2),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))
vi.mock("../../src/modules/project/project-document.storage.js", () => ({ destroyDocumentAsset: vi.fn(async () => undefined) }))

import app from "../../src/app.js"
import { uploadFileToCloudinary } from "../../src/shared/utils/cloudinary.js"
import { ProjectDocument } from "../../src/modules/project/project-document.model.js"
import { AiActionLog } from "../../src/modules/admin/ai-action-log.model.js"
import { buildDocumentContext } from "../../src/shared/ai/document-context.service.js"
import { ActionType } from "../../src/shared/ai/ai-action.types.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const url = (suffix = "") => "/api/v1/projects/" + seeded.projectId + "/documents" + suffix

const V1 = "Yêu cầu khách hàng\n\nKhách hàng đặt hàng online.\n\nThanh toán phải xong trong 3 giây.\n\nAdmin duyệt đơn trong ngày."
const V2 = V1.replace("3 giây", "2 giây")
const EMAIL = "Email khách hàng\n\nChỉ nhận thanh toán online, không COD."

let seeded: SeededFixture

const upload = (text: string, filename: string, fields: Record<string, string> = {}) => {
  const req = request(app).post(url()).set(bearer(seeded.token))
  for (const [k, v] of Object.entries(fields)) req.field(k, v)
  return req.attach("file", Buffer.from(text), { filename, contentType: "text/plain" })
}

const summarizeCalls = () => AiActionLog.countDocuments({ projectId: seeded.projectId, actionType: ActionType.SUMMARIZE_DOCUMENT })

beforeEach(async () => {
  seeded = await seedFixture("full")
  vi.mocked(uploadFileToCloudinary).mockClear()
})

describe("FLF-398 - trùng hệt", () => {
  it("tải lại đúng file (kể cả đổi tên) ⇒ 409 DUPLICATE_DOCUMENT, không lưu, không Cloudinary, không tóm tắt lần hai", async () => {
    const first = await upload(V1, "yeu-cau.txt")
    expect(first.status).toBe(201)
    const summaries = await summarizeCalls()

    const again = await upload(V1, "yeu-cau (1).txt")
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("DUPLICATE_DOCUMENT")
    expect(again.body.meta.document).toMatchObject({ id: String(first.body.data._id), name: "yeu-cau.txt", doc_code: 1 })

    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(1)
    expect(uploadFileToCloudinary).toHaveBeenCalledTimes(1)
    expect(await summarizeCalls()).toBe(summaries)
  })

  it("dự án khác tải cùng file ⇒ được; xoá rồi tải lại ⇒ được", async () => {
    const first = await upload(V1, "yeu-cau.txt")
    const other = await seedFixture("full")
    const otherRes = await request(app)
      .post("/api/v1/projects/" + other.projectId + "/documents")
      .set(bearer(other.token))
      .attach("file", Buffer.from(V1), { filename: "yeu-cau.txt", contentType: "text/plain" })
    expect(otherRes.status).toBe(201)

    expect((await request(app).delete(url("/" + first.body.data._id)).set(bearer(seeded.token))).status).toBe(200)
    expect((await upload(V1, "yeu-cau.txt")).status).toBe(201)
  })

  it("tài liệu cũ chưa có hash ⇒ so chữ đã đọc", async () => {
    await ProjectDocument.create({
      projectId: seeded.projectId,
      uploadedBy: seeded.userId,
      fileName: "legacy",
      originalName: "legacy.txt",
      mimeType: "text/plain",
      size: 10,
      cloudinaryPublicId: "legacy",
      url: "https://example.test/legacy",
      extractedText: EMAIL,
      parseStatus: "success",
      summaryStatus: "success"
    })
    const res = await upload(EMAIL, "email-khach.txt")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("DUPLICATE_DOCUMENT")
  })
})

describe("FLF-398 - bản mới của tài liệu đã có", () => {
  it("v1 rồi v2 (cùng tên gốc) ⇒ 409 POSSIBLE_NEW_VERSION kèm ứng viên; chưa lưu gì", async () => {
    const v1 = await upload(V1, "SRS_KhachHang_v1.txt")
    const res = await upload(V2, "SRS_KhachHang_v2.txt")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("POSSIBLE_NEW_VERSION")
    expect(res.body.meta.candidates).toEqual([
      expect.objectContaining({ id: String(v1.body.data._id), name: "SRS_KhachHang_v1.txt", doc_code: 1, reason: "same_name" })
    ])
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(1)
  })

  it("tên khác hẳn nhưng nội dung giống ≥ ngưỡng ⇒ hỏi (similar_content); khác hẳn ⇒ tải bình thường", async () => {
    await upload(V1, "Draft.txt")
    const similar = await upload(V2, "Final.txt")
    expect(similar.status).toBe(409)
    expect(similar.body.meta.candidates[0]).toMatchObject({ name: "Draft.txt", reason: "similar_content" })
    expect((await upload(EMAIL, "email.txt")).status).toBe(201)
  })

  it("Thay bản cũ ⇒ bản mới mã mới, bản cũ ẩn khỏi danh sách và ngữ cảnh model nhưng còn trong DB; xoá bản mới ⇒ bản cũ dùng lại", async () => {
    const v1 = await upload(V1, "SRS_KhachHang_v1.txt")
    const v1Id = String(v1.body.data._id)
    const v2 = await upload(V2, "SRS_KhachHang_v2.txt", { replace_document_id: v1Id })
    expect(v2.status).toBe(201)
    expect(v2.body.data.docCode).toBe(2)

    const old = await ProjectDocument.findById(v1Id).lean()
    expect(String(old!.supersededBy)).toBe(String(v2.body.data._id))
    expect(old!.docCode).toBe(1)

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.data.map((d: { originalName: string }) => d.originalName)).toEqual(["SRS_KhachHang_v2.txt"])
    expect(list.body.data[0].replaces).toEqual([{ id: v1Id, name: "SRS_KhachHang_v1.txt", doc_code: 1 }])

    const ctx = await buildDocumentContext({ projectId: seeded.projectId, actionType: ActionType.DRAFT, stepId: "S-6.4" })
    expect(ctx.contextText).toContain("2 giây")
    expect(ctx.contextText).not.toContain("3 giây")

    // Tải lại đúng v1 đã bị thay ⇒ báo bản cũ đã được thay bởi v2
    const oldAgain = await upload(V1, "SRS_KhachHang_v1.txt")
    expect(oldAgain.status).toBe(409)
    expect(oldAgain.body.meta.superseded_by).toMatchObject({ name: "SRS_KhachHang_v2.txt", doc_code: 2 })

    // v3 ⇒ chỉ hỏi thay v2 (v1 đã bị thay không là ứng viên)
    const v3 = await upload(V2 + "\n\nThêm: hỗ trợ ví điện tử.", "SRS_KhachHang_v3.txt")
    expect(v3.body.meta.candidates.map((c: { name: string }) => c.name)).toEqual(["SRS_KhachHang_v2.txt"])

    // Xoá v2 ⇒ v1 dùng lại
    expect((await request(app).delete(url("/" + v2.body.data._id)).set(bearer(seeded.token))).status).toBe(200)
    const after = await request(app).get(url()).set(bearer(seeded.token))
    expect(after.body.data.map((d: { originalName: string }) => d.originalName)).toEqual(["SRS_KhachHang_v1.txt"])
  })

  it("Giữ cả hai ⇒ lưu bản mới, không đụng bản cũ; trùng hệt vẫn chặn dù keep_both", async () => {
    await upload(V1, "SRS_KhachHang_v1.txt")
    const both = await upload(V2, "SRS_KhachHang_v2.txt", { keep_both: "true" })
    expect(both.status).toBe(201)
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId, supersededBy: null })).toBe(2)

    const dup = await upload(V1, "copy.txt", { keep_both: "true" })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe("DUPLICATE_DOCUMENT")
  })

  it("replace_document_id không thuộc dự án ⇒ 404; bản đã bị thay ⇒ 409 DOCUMENT_ALREADY_SUPERSEDED", async () => {
    const v1 = await upload(V1, "SRS_KhachHang_v1.txt")
    const missing = await upload(V2, "SRS_KhachHang_v2.txt", { replace_document_id: "650000000000000000000099" })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("DOCUMENT_NOT_FOUND")

    await upload(V2, "SRS_KhachHang_v2.txt", { replace_document_id: String(v1.body.data._id) })
    const stale = await upload(V2 + "\n\nv3", "SRS_KhachHang_v3.txt", { replace_document_id: String(v1.body.data._id) })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("DOCUMENT_ALREADY_SUPERSEDED")
  })
})
