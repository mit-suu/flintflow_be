/**
 * FLF-405 — tài liệu tham khảo giới hạn theo token phần chữ (business-flow §3.6): một trần mỗi lần tải (env) và một trần tổng
 * mỗi dự án theo gói (`plan.config`). Qua HTTP thật trên Mongo in-memory; Cloudinary và provider AI là bản giả. Trần được hạ
 * nhỏ trong test để không phải tạo file lớn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
import { env } from "../../src/config/env.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { uploadFileToCloudinary } from "../../src/shared/utils/cloudinary.js"
import { ProjectDocument } from "../../src/modules/project/project-document.model.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const PER_UPLOAD = 1000
const PER_PROJECT = 2500

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const url = (suffix = "") => "/api/v1/projects/" + seeded.projectId + "/documents" + suffix

/** Chữ khoảng `tokens` token (ước lượng ký tự / 4), mỗi file một bộ từ riêng để không bị coi là trùng / bản mới. */
let seq = 0
const textOf = (tokens: number): string => {
  seq += 1
  const words: string[] = []
  for (let i = 0; words.join(" ").length < tokens * 4; i += 1) words.push(`tl${seq}x${i.toString(36)}`)
  // Ký tự cuối không phải khoảng trắng (parser `trim()`), độ dài đúng `tokens * 4`
  return words.join(" ").slice(0, tokens * 4 - 1) + "z"
}

let seeded: SeededFixture

const upload = (text: string | Buffer, filename: string, fields: Record<string, string> = {}, contentType = "text/plain") => {
  const req = request(app).post(url()).set(bearer(seeded.token))
  for (const [k, v] of Object.entries(fields)) req.field(k, v)
  return req.attach("file", Buffer.isBuffer(text) ? text : Buffer.from(text), { filename, contentType })
}

const saved = { perUpload: env.REFERENCE_MAX_TOKENS_PER_UPLOAD, free: planConfig.free.maxReferenceTokens }

beforeEach(async () => {
  env.REFERENCE_MAX_TOKENS_PER_UPLOAD = PER_UPLOAD
  planConfig.free.maxReferenceTokens = PER_PROJECT
  seeded = await seedFixture("full")
  vi.mocked(uploadFileToCloudinary).mockClear()
})

afterEach(() => {
  env.REFERENCE_MAX_TOKENS_PER_UPLOAD = saved.perUpload
  planConfig.free.maxReferenceTokens = saved.free
})

describe("FLF-405 - trần một lần tải", () => {
  it("file vượt trần ⇒ 413 DOCUMENT_TOO_LONG kèm số token + trần; không record, không Cloudinary", async () => {
    const res = await upload(textOf(PER_UPLOAD + 200), "bien-ban-dai.txt")
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("DOCUMENT_TOO_LONG")
    expect(res.body.error.message).toContain("tách file hoặc chỉ giữ phần liên quan")
    expect(res.body.meta).toEqual({ file: "bien-ban-dai.txt", token_count: PER_UPLOAD + 200, limit: PER_UPLOAD })
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(uploadFileToCloudinary).not.toHaveBeenCalled()
  })
})

describe("FLF-405 - trần tổng dự án theo gói", () => {
  it("tổng vượt ⇒ 413 PROJECT_DOCUMENT_QUOTA_EXCEEDED kèm used + limit; GET trả meta đã dùng / trần", async () => {
    expect((await upload(textOf(900), "a.txt")).status).toBe(201)
    expect((await upload(textOf(900), "b.txt", { keep_both: "true" })).status).toBe(201)

    const res = await upload(textOf(800), "c.txt", { keep_both: "true" })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("PROJECT_DOCUMENT_QUOTA_EXCEEDED")
    expect(res.body.meta).toEqual({ file: "c.txt", token_count: 800, used: 1800, limit: PER_PROJECT })
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(2)
    expect(uploadFileToCloudinary).toHaveBeenCalledTimes(2)

    // Vừa đủ trần vẫn nhận
    expect((await upload(textOf(700), "d.txt", { keep_both: "true" })).status).toBe(201)

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.status).toBe(200)
    expect(list.body.meta).toEqual({ tokens_used: PER_PROJECT, tokens_limit: PER_PROJECT, tokens_per_upload_limit: PER_UPLOAD })
  })

  it("Thay bản cũ ⇒ trừ token bản bị thay trước khi so; bản đã bị thay không tính vào tổng", async () => {
    const base = textOf(900)
    const v1 = await upload(base, "SRS_KhachHang_v1.txt")
    expect((await upload(textOf(900), "email.txt", { keep_both: "true" })).status).toBe(201)

    // 1800 + 1000 > 2500 nếu không trừ; thay v1 (900) ⇒ 900 + 1000 = 1900 ≤ 2500
    const v2 = await upload(textOf(1000), "SRS_KhachHang_v2.txt", { replace_document_id: String(v1.body.data._id) })
    expect(v2.status).toBe(201)

    // v1 đã bị thay không tính: dùng 1900 ⇒ thêm 600 vừa đủ
    expect((await upload(textOf(600), "ghi-chu.txt", { keep_both: "true" })).status).toBe(201)
    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.meta.tokens_used).toBe(PER_PROJECT)
  })

  it("tài liệu đã có trước khi bật trần không bị chặn / xoá; dự án đang vượt chỉ không tải thêm được, xoá bớt thì tải lại được", async () => {
    const legacy = await ProjectDocument.create({
      projectId: seeded.projectId,
      uploadedBy: seeded.userId,
      fileName: "legacy",
      originalName: "legacy.txt",
      mimeType: "text/plain",
      size: 10,
      cloudinaryPublicId: "legacy",
      url: "https://example.test/legacy",
      extractedText: "cũ",
      tokenCount: PER_PROJECT + 500,
      parseStatus: "success",
      summaryStatus: "success"
    })

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.meta.tokens_used).toBe(PER_PROJECT + 500)

    const blocked = await upload(textOf(100), "moi.txt", { keep_both: "true" })
    expect(blocked.status).toBe(413)
    expect(blocked.body.error.code).toBe("PROJECT_DOCUMENT_QUOTA_EXCEEDED")

    expect((await request(app).delete(url("/" + legacy._id)).set(bearer(seeded.token))).status).toBe(200)
    expect((await upload(textOf(100), "moi.txt")).status).toBe(201)
  })
})

describe("FLF-405 - sát trần vẫn được hỏi Thay bản cũ", () => {
  it("bản mới làm tổng vượt nếu giữ cả hai ⇒ 409 POSSIBLE_NEW_VERSION (không phải 413); chọn Thay ⇒ 201; Giữ cả hai ⇒ 413", async () => {
    const base = textOf(900)
    const v1 = await upload(base, "bien-ban.txt")
    expect((await upload(textOf(900), "email.txt", { keep_both: "true" })).status).toBe(201)
    const v2Text = base.slice(0, -40) + " ban moi sua doi cuoi cung z"

    const ask = await upload(v2Text, "bien-ban.txt")
    expect(ask.status).toBe(409)
    expect(ask.body.error.code).toBe("POSSIBLE_NEW_VERSION")

    const both = await upload(v2Text, "bien-ban.txt", { keep_both: "true" })
    expect(both.status).toBe(413)
    expect(both.body.error.code).toBe("PROJECT_DOCUMENT_QUOTA_EXCEEDED")

    const replace = await upload(v2Text, "bien-ban.txt", { replace_document_id: String(v1.body.data._id) })
    expect(replace.status).toBe(201)
    expect(uploadFileToCloudinary).toHaveBeenCalledTimes(3)
  })
})

describe("FLF-405 - hành vi cũ giữ nguyên", () => {
  it("parse lỗi ⇒ vẫn lưu failed, không tính vào tổng", async () => {
    const res = await upload(Buffer.from("không phải pdf " + "x".repeat(20000)), "scan.pdf", {}, "application/pdf")
    expect(res.status).toBe(201)
    expect(res.body.data.parseStatus).toBe("failed")
    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.meta.tokens_used).toBe(0)
  })

  it("dưới trần ⇒ kiểm trùng FLF-398 vẫn chạy", async () => {
    const text = textOf(300)
    expect((await upload(text, "a.txt")).status).toBe(201)
    const dup = await upload(text, "a (1).txt")
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe("DUPLICATE_DOCUMENT")
  })
})
