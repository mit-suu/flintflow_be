import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose ChatSession. */
const db = vi.hoisted(() => {
  interface Doc {
    _id: string
    projectId: string
    messages: unknown[]
    isActive: boolean
    is_pipeline: boolean
    createdAt: string
  }
  const rows: Doc[] = []
  let seq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const withMethods = (doc: Doc | null) => (doc ? { ...copy(doc), save: async function (this: Doc) { Object.assign(rows.find((r) => r._id === this._id)!, this) } } : null)

  const ChatSession = {
    create: async (input: Partial<Doc>) => {
      const doc: Doc = {
        _id: `s${++seq}`,
        projectId: String(input.projectId),
        messages: input.messages ?? [],
        isActive: input.isActive ?? true,
        is_pipeline: input.is_pipeline ?? false,
        createdAt: new Date(Date.now() + seq).toISOString()
      }
      rows.push(doc)
      return withMethods(doc)
    },
    exists: async (filter: Partial<Doc>) =>
      rows.some((r) => (filter.projectId === undefined || r.projectId === String(filter.projectId)) && (filter.is_pipeline === undefined || r.is_pipeline === filter.is_pipeline))
        ? { _id: "x" }
        : null,
    findById: async (id: string, _proj?: unknown) => withMethods(rows.find((r) => r._id === id) ?? null),
    findOne: (filter: Partial<Doc>) => ({
      sort: async (sortSpec: { createdAt?: number }) => {
        const matched = rows.filter((r) => filter.projectId === undefined || r.projectId === String(filter.projectId))
        matched.sort((a, b) => (sortSpec.createdAt === -1 ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)))
        return withMethods(matched[0] ?? null)
      }
    }),
    deleteOne: async (filter: { _id: string }) => {
      const idx = rows.findIndex((r) => r._id === filter._id)
      if (idx < 0) return { deletedCount: 0 }
      rows.splice(idx, 1)
      return { deletedCount: 1 }
    },
    updateOne: async (filter: { _id: string }, update: Partial<Doc> | { $push: unknown }) => {
      const row = rows.find((r) => r._id === filter._id)
      if (row && !("$push" in update)) Object.assign(row, update)
      return { modifiedCount: row ? 1 : 0 }
    }
  }
  const reset = () => {
    rows.length = 0
    seq = 0
  }
  return { ChatSession, rows, reset }
})

vi.mock("./chat-session.model.js", () => ({ ChatSession: db.ChatSession }))

const aiMocks = vi.hoisted(() => ({
  executeAiAction: vi.fn(),
  executeAiActionStream: vi.fn()
}))
vi.mock("../../shared/ai/ai-action.service.js", () => aiMocks)
vi.mock("../../shared/ai/document-context.service.js", () => ({
  buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false }))
}))
vi.mock("../../shared/ai/prompt-registry.service.js", () => ({
  getPromptTemplate: vi.fn(async () => ({ actionType: "chat", template: "x", providerConfig: { provider: "mock", model: "mock", maxTokens: 100 } }))
}))

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { createChatSession, deleteChatSession, sendMessageAndGetResponse } from "./chat-session.service.js"

const PROJECT = "650000000000000000000001"

beforeEach(() => {
  db.reset()
  aiMocks.executeAiAction.mockReset()
  aiMocks.executeAiActionStream.mockReset()
})

describe("chat-session bất biến 7 (srs-spine.md §6)", () => {
  it("createChatSession: session đầu giữ is_pipeline=true, session sau false — không tắt isActive của session khác", async () => {
    const first = await createChatSession(PROJECT)
    const second = await createChatSession(PROJECT)
    expect(first.is_pipeline).toBe(true)
    expect(second.is_pipeline).toBe(false)
    // Tạo session thứ hai không được tắt isActive của session đầu (bỏ hành vi updateMany cũ)
    const reloadedFirst = db.rows.find((r) => r._id === String(first._id))!
    expect(reloadedFirst.isActive).toBe(true)
  })

  it("deleteChatSession: xoá session pipeline ⇒ promote session gần nhất còn lại thành pipeline", async () => {
    const pipeline = await createChatSession(PROJECT)
    const second = await createChatSession(PROJECT)
    const third = await createChatSession(PROJECT)
    expect(pipeline.is_pipeline).toBe(true)

    await deleteChatSession(String(pipeline._id))

    const remaining = db.rows.filter((r) => r.projectId === PROJECT)
    expect(remaining).toHaveLength(2)
    const pipelineNow = remaining.filter((r) => r.is_pipeline)
    expect(pipelineNow).toHaveLength(1)
    // Gần nhất theo createdAt là session tạo sau cùng còn lại (third)
    expect(pipelineNow[0]._id).toBe(String(third._id))
    void second
  })

  it("deleteChatSession: xoá session không pipeline không đụng tới session pipeline hiện có", async () => {
    const pipeline = await createChatSession(PROJECT)
    const second = await createChatSession(PROJECT)

    await deleteChatSession(String(second._id))

    const remaining = db.rows.filter((r) => r.projectId === PROJECT)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]._id).toBe(String(pipeline._id))
    expect(remaining[0].is_pipeline).toBe(true)
  })

  it("sendMessage* ở session KHÔNG pipeline chỉ cho CHAT — discoveryStep bị bỏ qua, không gọi CHAT_DISCOVERY", async () => {
    const pipeline = await createChatSession(PROJECT)
    const chatOnly = await createChatSession(PROJECT)
    expect(pipeline.is_pipeline).toBe(true)
    expect(chatOnly.is_pipeline).toBe(false)

    aiMocks.executeAiAction.mockResolvedValue({
      success: true,
      data: { reply: "ok", questions: [] },
      rawText: "{}",
      actionType: ActionType.CHAT,
      provider: "mock",
      aiModel: "mock",
      tokensUsed: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      logId: "log-1",
      cost: 1
    })

    await sendMessageAndGetResponse(PROJECT, String(chatOnly._id), "hello", "vision_problem", "user-1", 1)

    expect(aiMocks.executeAiAction).toHaveBeenCalledTimes(1)
    expect(aiMocks.executeAiAction.mock.calls[0][0]).toBe(ActionType.CHAT)
  })
})
