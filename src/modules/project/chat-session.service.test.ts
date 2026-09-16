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

/** T17: change flow gọi từ session không pipeline — giữ `isChangeInstruction` thật, chỉ giả `preview`. */
const changeMocks = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock("../spine/change.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/change.service.js")>()
  return { ...actual, preview: changeMocks.preview }
})
const spineRepoMocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock("../spine/spine.repository.js", () => spineRepoMocks)

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { createChatSession, deleteChatSession, sendMessageAndGetResponse, assertChatSessionOwnership } from "./chat-session.service.js"
import { ApiError } from "../../shared/utils/api-error.js"

const PROJECT = "650000000000000000000001"
const OTHER_PROJECT = "650000000000000000000002"

beforeEach(() => {
  db.reset()
  aiMocks.executeAiAction.mockReset()
  aiMocks.executeAiActionStream.mockReset()
  changeMocks.preview.mockReset()
  spineRepoMocks.get.mockReset()
  // T20: `tryAnswerRunningStep` đọc `progress.current_step` ⇒ stub phải có `progress` như bản ghi thật
  spineRepoMocks.get.mockResolvedValue({ projectId: PROJECT, spine_version: 7, progress: { current_step: null } })
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

describe("assertChatSessionOwnership (F5 — chặn IDOR: chatId phải thuộc đúng projectId)", () => {
  it("chatId thuộc project khác ⇒ 404 CHAT_SESSION_NOT_FOUND (không lộ chatId có tồn tại hay không)", async () => {
    const session = await createChatSession(PROJECT)

    const err = await assertChatSessionOwnership(OTHER_PROJECT, String(session._id)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(404)
    expect((err as ApiError).code).toBe("CHAT_SESSION_NOT_FOUND")
  })

  it("chatId không tồn tại ⇒ 404 CHAT_SESSION_NOT_FOUND", async () => {
    const err = await assertChatSessionOwnership(PROJECT, "000000000000000000000000").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe("CHAT_SESSION_NOT_FOUND")
  })

  it("chatId thuộc đúng project ⇒ trả về session", async () => {
    const session = await createChatSession(PROJECT)
    const found = await assertChatSessionOwnership(PROJECT, String(session._id))
    expect(String(found._id)).toBe(String(session._id))
  })
})

describe("T17 — lệnh sửa từ session KHÔNG pipeline đi qua change flow", () => {
  const USER = "650000000000000000000010"

  it("lệnh sửa: gọi change.service.preview, ghi thẻ preview vào transcript, KHÔNG gọi CHAT", async () => {
    const pipeline = await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    expect(plain.is_pipeline).toBe(false)
    void pipeline

    changeMocks.preview.mockResolvedValue({
      ok: true,
      txn: "t",
      base_version: 7,
      ops: [],
      changes: [{ op: "set", path: "actors[id=A01].name", before: "Founder", value: "Product Owner", reason: null }],
      violations: [],
      referrers: [],
      branch: "dependent",
      impact: { fields: ["actors[id=A01].name"], sections: [{ id: "fixed:2.1", relation: "owner" }], diagrams: ["usecase"], referrers: [] },
      preview_id: "pv-1"
    })

    const session = await sendMessageAndGetResponse(PROJECT, String(plain._id), "Đổi tên actor A01 thành Product Owner", "overview", USER)

    expect(changeMocks.preview).toHaveBeenCalledWith(PROJECT, USER, {
      instruction: "Đổi tên actor A01 thành Product Owner",
      base_version: 7
    })
    expect(aiMocks.executeAiAction).not.toHaveBeenCalled()

    const last = session.messages[session.messages.length - 1] as { role: string; content: string }
    expect(last.role).toBe("ai")
    const payload = JSON.parse(last.content) as { kind: string; preview_id: string; branch: string }
    expect(payload).toMatchObject({ kind: "change_preview", preview_id: "pv-1", branch: "dependent" })
  })

  it("câu hỏi thường vẫn đi CHAT, không đụng change flow", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    aiMocks.executeAiAction.mockResolvedValue({ data: { reply: "ok", questions: [] }, tokensUsed: {}, cost: 0 })

    await sendMessageAndGetResponse(PROJECT, String(plain._id), "Tài liệu này đang thiếu gì?", "overview", USER)

    expect(changeMocks.preview).not.toHaveBeenCalled()
    expect(aiMocks.executeAiAction).toHaveBeenCalledWith(ActionType.CHAT, expect.anything(), PROJECT, USER)
  })

  it("session pipeline không bị chặn: lệnh sửa vẫn đi CHAT (pipeline sửa qua gate/step runner)", async () => {
    const pipeline = await createChatSession(PROJECT)
    aiMocks.executeAiAction.mockResolvedValue({ data: { reply: "ok", questions: [] }, tokensUsed: {}, cost: 0 })

    await sendMessageAndGetResponse(PROJECT, String(pipeline._id), "Đổi tên actor A01", "overview", USER)

    expect(changeMocks.preview).not.toHaveBeenCalled()
    expect(aiMocks.executeAiAction).toHaveBeenCalled()
  })

  it("project chưa có Spine ⇒ không chuyển hướng, vẫn CHAT", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    spineRepoMocks.get.mockResolvedValue(null)
    aiMocks.executeAiAction.mockResolvedValue({ data: { reply: "ok", questions: [] }, tokensUsed: {}, cost: 0 })

    await sendMessageAndGetResponse(PROJECT, String(plain._id), "Thêm actor Guest", "overview", USER)

    expect(changeMocks.preview).not.toHaveBeenCalled()
    expect(aiMocks.executeAiAction).toHaveBeenCalled()
  })

  it("preview lỗi ⇒ ghi thẻ change_error, không làm hỏng phiên chat", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    changeMocks.preview.mockRejectedValue(new ApiError(402, "Không đủ credit", "INSUFFICIENT_CREDIT"))

    const session = await sendMessageAndGetResponse(PROJECT, String(plain._id), "Xoá actor A08", "overview", USER)

    const last = session.messages[session.messages.length - 1] as { content: string }
    expect(JSON.parse(last.content)).toMatchObject({ kind: "change_error", reply: "Không đủ credit" })
  })
})
