import { describe, it, expect, vi, beforeEach } from "vitest"

const envMock = vi.hoisted(() => ({ AI_PAYLOAD_RETENTION_DAYS: 30, AI_PAYLOAD_MAX_CHARS: 100 }))
const created = vi.hoisted(() => ({ docs: [] as Record<string, unknown>[], fail: false }))

vi.mock("../../config/env.js", () => ({ env: envMock }))
vi.mock("../../modules/admin/ai-action-payload.model.js", () => ({
  AiActionPayload: {
    create: async (doc: Record<string, unknown>) => {
      if (created.fail) throw new Error("E11000 duplicate key")
      created.docs.push(doc)
      return doc
    }
  }
}))

const { capturePayload, clipPayload, isPayloadCaptureEnabled } = await import("./ai-action-payload.service.js")

const LOG = "650000000000000000000001"
const USER = "650000000000000000000010"
const PROJECT = "650000000000000000000020"

const input = (over: Partial<Parameters<typeof capturePayload>[0]> = {}) => ({
  logId: LOG,
  projectId: PROJECT,
  userId: USER,
  actionType: "DRAFT_TO_OPS",
  prompt: "prompt ngắn",
  response: "response ngắn",
  ...over
})

beforeEach(() => {
  created.docs = []
  created.fail = false
  envMock.AI_PAYLOAD_RETENTION_DAYS = 30
  envMock.AI_PAYLOAD_MAX_CHARS = 100
})

describe("clipPayload", () => {
  it("dưới trần thì giữ nguyên từng ký tự", () => {
    expect(clipPayload("abc", 10)).toBe("abc")
    expect(clipPayload("a".repeat(10), 10)).toBe("a".repeat(10))
  })

  it("quá trần thì cắt GIỮA — đầu là luật của skill, cuối là projection và câu trả lời của user", () => {
    const text = `${"H".repeat(50)}${"M".repeat(100)}${"T".repeat(50)}`
    const clipped = clipPayload(text, 100)

    expect(clipped.startsWith("H".repeat(50))).toBe(true)
    expect(clipped.endsWith("T".repeat(40))).toBe(true)
    expect(clipped).toContain("…[cắt 100 ký tự]…")
    // Phần giữa mới là phần mất; không được mất đầu lẫn cuối
    expect(clipped).not.toContain("M".repeat(60))
  })
})

describe("capturePayload", () => {
  it("ghi bản đã cắt nhưng độ dài THẬT giữ nguyên — đọc log phải biết mình đang xem bản cắt", async () => {
    const prompt = "p".repeat(500)
    const response = "r".repeat(300)
    await capturePayload(input({ prompt, response }))

    expect(created.docs).toHaveLength(1)
    const doc = created.docs[0] as { prompt: string; response: string; promptChars: number; responseChars: number }
    expect(doc.promptChars).toBe(500)
    expect(doc.responseChars).toBe(300)
    expect(doc.prompt.length).toBeLessThan(500)
    expect(doc.response.length).toBeLessThan(300)
  })

  it("AI_PAYLOAD_RETENTION_DAYS=0 ⇒ không lưu gì (tắt hẳn, không chỉ dọn sớm)", async () => {
    envMock.AI_PAYLOAD_RETENTION_DAYS = 0
    expect(isPayloadCaptureEnabled()).toBe(false)

    await capturePayload(input())
    expect(created.docs).toEqual([])
  })

  it("lượt chạy chết trước khi model trả chữ nào ⇒ response null, responseChars 0", async () => {
    await capturePayload(input({ response: null }))

    const doc = created.docs[0] as { response: string | null; responseChars: number }
    expect(doc.response).toBeNull()
    expect(doc.responseChars).toBe(0)
  })

  it("ghi payload thất bại KHÔNG được ném — lượt gọi model đã thành công thì không đổ vì log phụ", async () => {
    created.fail = true
    await expect(capturePayload(input())).resolves.toBeUndefined()
  })

  it("không có projectId (lượt gọi ngoài dự án) vẫn ghi được", async () => {
    await capturePayload(input({ projectId: undefined }))

    const doc = created.docs[0] as { projectId: unknown }
    expect(doc.projectId).toBeNull()
  })
})
