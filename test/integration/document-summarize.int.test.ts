/**
 * FLF-458 (business-flow §3.6 "Đọc một lần dùng lại nhiều lần"): tài liệu tham khảo chỉ được Code trích chữ lúc tải lên
 * (không gọi AI, không tốn credit); AI chỉ đọc + tóm tắt sau khi người dùng xem credit cần (`GET /documents`
 * `meta.summary_credit_estimate`) và xác nhận (`POST /documents/summarize`). Cloudinary / provider AI là bản giả.
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
import { AiActionLog } from "../../src/modules/admin/ai-action-log.model.js"
import { ActionType } from "../../src/shared/ai/ai-action.types.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const url = (suffix = "") => "/api/v1/projects/" + seeded.projectId + "/documents" + suffix

let seeded: SeededFixture

const upload = (text: string, filename = "bien-ban.txt") =>
  request(app).post(url()).set(bearer(seeded.token)).attach("file", Buffer.from(text), { filename, contentType: "text/plain" })

const summarizeCalls = () => AiActionLog.countDocuments({ projectId: seeded.projectId, actionType: ActionType.SUMMARIZE_DOCUMENT })

const MINUTES = "Biên bản họp kick-off.\n\nKhách hàng cần duyệt đơn trong 1 ngày."

beforeEach(async () => {
  seeded = await seedFixture("full")
  resetMockLlm()
  // Khớp đúng prompt phẳng của summarize_document (assets/prompts/summarize_document.md) — các lượt khác (nếu có) đi đường mặc định
  mockOverrides.next = (prompt) => (prompt.includes("Summarize the following document content") ? JSON.stringify({ summary: "Tóm tắt giả." }) : undefined)
})

describe("FLF-458 - upload tài liệu tham khảo không còn gọi AI ngay", () => {
  it("upload ⇒ summaryStatus pending, không gọi AI, không tốn credit", async () => {
    const res = await upload(MINUTES)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({ parseStatus: "success", summaryStatus: "pending", summary: null })
    expect(await summarizeCalls()).toBe(0)
  })

  it("GET /documents báo credit cần để đọc tài liệu đang chờ (summary_credit_estimate)", async () => {
    await upload(MINUTES, "a.txt")
    await upload(MINUTES.replace("1 ngày", "2 ngày"), "b.txt")

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.status).toBe(200)
    expect(list.body.meta.summary_credit_estimate).toMatchObject({ documents: 2 })
    expect(list.body.meta.summary_credit_estimate.credits).toBeGreaterThan(0)
    expect(list.body.meta.summary_credit_estimate.available_credits).toBeGreaterThanOrEqual(0)
  })

  it("POST /documents/summarize ⇒ AI đọc tài liệu đang chờ, trừ credit, summary_credit_estimate về 0", async () => {
    const uploaded = await upload(MINUTES)
    expect(await summarizeCalls()).toBe(0)

    const res = await request(app).post(url("/summarize")).set(bearer(seeded.token)).send({})
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ _id: uploaded.body.data._id, summaryStatus: "success", summary: "Tóm tắt giả." })
    expect(await summarizeCalls()).toBe(1)

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.meta.summary_credit_estimate).toMatchObject({ documents: 0, credits: 0 })
  })

  it("document_ids chỉ đọc đúng tài liệu được chọn, tài liệu khác vẫn chờ", async () => {
    const a = await upload(MINUTES, "a.txt")
    await upload(MINUTES.replace("1 ngày", "2 ngày"), "b.txt")

    const res = await request(app).post(url("/summarize")).set(bearer(seeded.token)).send({ document_ids: [a.body.data._id] })
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]._id).toBe(a.body.data._id)

    const list = await request(app).get(url()).set(bearer(seeded.token))
    expect(list.body.meta.summary_credit_estimate.documents).toBe(1)
  })

  it("lỗi AI ở một tài liệu không chặn tài liệu khác ⇒ summaryStatus failed, phần còn lại vẫn đọc được", async () => {
    await upload(MINUTES, "a.txt")
    await upload(MINUTES.replace("1 ngày", "2 ngày"), "b.txt")
    // "2 ngày" lỗi ở MỌI lượt gọi (kể cả 2 lần thử lại của executeAiAction) ⇒ tài liệu đó chắc chắn "failed"
    mockOverrides.next = (prompt) => {
      if (!prompt.includes("Summarize the following document content")) return undefined
      return prompt.includes("2 ngày") ? new Error("provider lỗi") : JSON.stringify({ summary: "Tóm tắt giả." })
    }

    const res = await request(app).post(url("/summarize")).set(bearer(seeded.token)).send({})
    expect(res.status).toBe(200)
    const statuses = (res.body.data as { summaryStatus: string }[]).map((d) => d.summaryStatus).sort()
    expect(statuses).toEqual(["failed", "success"])
  })
})
