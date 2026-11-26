/**
 * FLF-458: hết credit khi AI đọc tài liệu tham khảo ⇒ tài liệu giữ `pending` (đọc lại được sau khi nạp credit), không kẹt `failed`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ docs: [] as { originalName: string; extractedText: string; summaryStatus: string; summary?: string; save: () => Promise<void> }[], ai: vi.fn() }))

vi.mock("./project-document.model.js", () => ({ ProjectDocument: { find: async () => h.docs } }))
vi.mock("./project.service.js", () => ({ getProjectById: vi.fn(async () => ({})) }))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: h.ai }))

import { summarizeReferenceDocuments } from "./project-document.service.js"

const doc = (name: string) => ({ originalName: name, extractedText: "x", summaryStatus: "pending", save: vi.fn(async () => undefined) })

describe("summarizeReferenceDocuments - FLF-458 hết credit", () => {
  beforeEach(() => {
    h.ai.mockReset()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  it("tài liệu 1 đọc xong, tài liệu 2 hết credit ⇒ 2 và 3 giữ pending, không failed, ném 402 cho FE", async () => {
    const [a, b, c] = [doc("a"), doc("b"), doc("c")]
    h.docs = [a, b, c]
    h.ai.mockResolvedValueOnce({ data: { summary: "tóm tắt" } }).mockRejectedValueOnce(Object.assign(new Error("Không đủ credit"), { code: "INSUFFICIENT_CREDIT" }))
    await expect(summarizeReferenceDocuments("o", "u", "507f1f77bcf86cd799439011")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
    expect(a.summaryStatus).toBe("success")
    expect(b.summaryStatus).toBe("pending")
    expect(c.summaryStatus).toBe("pending")
    expect(h.ai).toHaveBeenCalledTimes(2)
  })

  it("lỗi AI khác ⇒ chỉ tài liệu đó failed, các tài liệu sau vẫn đọc", async () => {
    const [a, b] = [doc("a"), doc("b")]
    h.docs = [a, b]
    h.ai.mockRejectedValueOnce(new Error("provider")).mockResolvedValueOnce({ data: { summary: "ok" } })
    await summarizeReferenceDocuments("o", "u", "507f1f77bcf86cd799439011")
    expect(a.summaryStatus).toBe("failed")
    expect(b.summaryStatus).toBe("success")
  })
})
