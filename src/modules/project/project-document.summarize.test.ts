/**
 * FLF-458: hết credit khi AI đọc tài liệu tham khảo ⇒ tài liệu giữ `pending` (đọc lại được sau khi nạp credit), không kẹt `failed`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ docs: [] as { _id: string; originalName: string; extractedText: string; summaryStatus: string; summaryClaimedAt?: Date | null; summary?: string; save: () => Promise<void> }[], ai: vi.fn() }))

vi.mock("./project-document.model.js", () => ({
  ProjectDocument: {
    find: async () => h.docs,
    countDocuments: async () => h.docs.length,
    // Giành nguyên tử: chỉ tài liệu còn pending mới giành được
    findOneAndUpdate: async (q: { _id: string }) => {
      const d = h.docs.find((x) => x._id === q._id)
      if (!d || d.summaryStatus !== "pending") return null
      d.summaryStatus = "running"
      return d
    },
    updateMany: async (q: { _id: { $in: string[] } }) => {
      for (const d of h.docs) if (q._id.$in.includes(d._id) && d.summaryStatus === "running") d.summaryStatus = "pending"
    }
  }
}))
vi.mock("./project.service.js", () => ({ getProjectById: vi.fn(async () => ({})) }))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: h.ai }))

import { pendingSummaryCredits, summarizeReferenceDocuments } from "./project-document.service.js"

let seq = 0
const doc = (name: string) => ({ _id: `d${++seq}`, originalName: name, extractedText: "x", summaryStatus: "pending", save: vi.fn(async () => undefined) })

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

describe("summarizeReferenceDocuments - hai lượt Bắt đầu đồng thời", () => {
  it("cùng tài liệu pending ⇒ chỉ một lượt gọi AI / trừ credit", async () => {
    const [a, b] = [doc("a"), doc("b")]
    h.docs = [a, b]
    h.ai.mockReset()
    h.ai.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { data: { summary: "ok" } }
    })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await Promise.all([summarizeReferenceDocuments("o", "u", "p"), summarizeReferenceDocuments("o", "u", "p")])
    expect(h.ai).toHaveBeenCalledTimes(2)
    expect([a.summaryStatus, b.summaryStatus]).toEqual(["success", "success"])
  })
})

describe("pendingSummaryCredits - FLF-458 cộng vào màn đọc khung", () => {
  it("không tài liệu chờ ⇒ 0 credit; có n tài liệu ⇒ n lượt đọc", async () => {
    h.docs = []
    expect(await pendingSummaryCredits("p")).toEqual({ documents: 0, credits: 0 })
    h.docs = [doc("a"), doc("b")]
    const r = await pendingSummaryCredits("p")
    expect(r.documents).toBe(2)
    expect(r.credits).toBeGreaterThan(0)
    expect(r.credits % 2).toBe(0)
  })
})
