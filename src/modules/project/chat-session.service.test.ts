import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose ChatSession. */
const db = vi.hoisted(() => {
  interface Doc {
    _id: string
    projectId: string
    messages: unknown[]
    is_pipeline: boolean
    createdAt: string
  }
  const rows: Doc[] = []
  let seq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const withMethods = (doc: Doc | null) =>
    doc
      ? {
          ...copy(doc),
          // Chỉ ghi dữ liệu, không ghi chính hàm `save` vào store (lượt findById sau sẽ structuredClone được)
          save: async function (this: Doc & { save?: unknown }) {
            const { save: _save, ...data } = this
            Object.assign(rows.find((r) => r._id === this._id)!, data)
          }
        }
      : null

  const ChatSession = {
    create: async (input: Partial<Doc>) => {
      const doc: Doc = {
        _id: String(++seq).padStart(24, "a"), // id hợp lệ ObjectId (service kiểm isValidObjectId)
        projectId: String(input.projectId),
        messages: input.messages ?? [],
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
    /** Chỉ hỗ trợ projection `{ messages: { $slice: -1 } }` mà `getChatSessions` dùng. */
    find: (filter: { projectId: string }, projection?: { messages?: { $slice: number } }) => ({
      sort: async (sortSpec: { createdAt?: number }) => {
        const matched = rows.filter((r) => r.projectId === String(filter.projectId)).map(copy)
        matched.sort((a, b) => (sortSpec.createdAt === -1 ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)))
        const slice = projection?.messages?.$slice
        return slice === undefined ? matched : matched.map((r) => ({ ...r, messages: r.messages.slice(slice) }))
      }
    }),
    findOne: (filter: Partial<Doc>) => ({
      sort: async (sortSpec: { createdAt?: number }) => {
        const matched = rows.filter((r) => filter.projectId === undefined || r.projectId === String(filter.projectId))
        matched.sort((a, b) => (sortSpec.createdAt === -1 ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)))
        return withMethods(matched[0] ?? null)
      }
    }),
    deleteOne: async (filter: { _id: string; is_pipeline?: boolean }) => {
      const idx = rows.findIndex((r) => r._id === filter._id && (filter.is_pipeline === undefined || r.is_pipeline === filter.is_pipeline))
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
import { createChatSession, deleteChatSession, getChatSessions, sendMessageAndGetResponse, assertChatSessionOwnership, PIPELINE_SESSION_LOCKED } from "./chat-session.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { TransactionRejectedError } from "../spine/op-engine.js"

const PROJECT = "650000000000000000000001"
const OTHER_PROJECT = "650000000000000000000002"

beforeEach(() => {
  db.reset()
  aiMocks.executeAiAction.mockReset()
  aiMocks.executeAiActionStream.mockReset()
  changeMocks.preview.mockReset()
  spineRepoMocks.get.mockReset()
  // T20: `tryAnswerRunningStep` đọc `progress.current_step` ⇒ stub phải có `progress` như bản ghi thật
  // FLF-244: CHAT/lệnh sửa dựng tóm tắt từ `project` + `decisions` + `addendum` ⇒ stub có đủ các field đó
  spineRepoMocks.get.mockResolvedValue({
    projectId: PROJECT,
    spine_version: 7,
    progress: { current_step: null },
    project: { vision: null, goals: [] },
    decisions: [],
    addendum: []
  })
})

describe("chat-session bất biến 7 (srs-spine.md §6)", () => {
  it("createChatSession: session đầu giữ is_pipeline=true, session sau false, session đầu vẫn là pipeline", async () => {
    const first = await createChatSession(PROJECT)
    const second = await createChatSession(PROJECT)
    expect(first.is_pipeline).toBe(true)
    expect(second.is_pipeline).toBe(false)
    expect(db.rows.find((r) => r._id === String(first._id))!.is_pipeline).toBe(true)
  })

  it("FLF-244: deleteChatSession phiên pipeline ⇒ 409 PIPELINE_SESSION_LOCKED, không xoá, không promote", async () => {
    const pipeline = await createChatSession(PROJECT)
    await createChatSession(PROJECT)

    const err = await deleteChatSession(String(pipeline._id)).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(409)
    expect((err as ApiError).code).toBe(PIPELINE_SESSION_LOCKED)
    const remaining = db.rows.filter((r) => r.projectId === PROJECT)
    expect(remaining).toHaveLength(2)
    expect(remaining.filter((r) => r.is_pipeline).map((r) => r._id)).toEqual([String(pipeline._id)])
  })

  it("FLF-244: getChatSessions trả mỗi phiên kèm đúng tin cuối, mới nhất trước", async () => {
    const first = await createChatSession(PROJECT)
    const second = await createChatSession(PROJECT)
    db.rows.find((r) => r._id === String(first._id))!.messages = [{ role: "user", content: "a" }, { role: "ai", content: "b" }]

    const list = await getChatSessions(PROJECT)

    expect(list.map((s) => String(s._id))).toEqual([String(second._id), String(first._id)])
    expect(list[1].messages).toEqual([{ role: "ai", content: "b" }])
    expect(list[0].messages).toEqual([])
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

describe("T17 — lệnh sửa đi qua change flow (mọi session)", () => {
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
      base_version: 7,
      chat_history: ""
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

  it("FLF-201 (BUG-09): lệnh sửa trong session pipeline cũng đi change flow, không để CHAT hứa suông", async () => {
    const pipeline = await createChatSession(PROJECT)
    aiMocks.executeAiAction.mockResolvedValue({ data: { reply: "ok", questions: [] }, tokensUsed: {}, cost: 0 })
    changeMocks.preview.mockResolvedValue({
      ok: true,
      txn: "t",
      base_version: 7,
      ops: [],
      changes: [{ op: "add", path: "use_cases[id=UC18]", before: { _absent: true }, value: { id: "UC18" }, reason: null }],
      violations: [],
      referrers: [],
      branch: "dependent",
      preview_id: "pv-2"
    })

    const session = await sendMessageAndGetResponse(PROJECT, String(pipeline._id), "Thêm use case nhắc lịch hẹn", "overview", USER)

    expect(changeMocks.preview).toHaveBeenCalled()
    expect(aiMocks.executeAiAction, "không gọi CHAT: câu trả lời là bản xem trước thật").not.toHaveBeenCalled()
    const last = session.messages[session.messages.length - 1] as { role: string; content: string }
    expect(JSON.parse(last.content)).toMatchObject({ kind: "change_preview" })
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

  it("FLF-247: lô op bị từ chối ⇒ change_error là câu thường, không path op", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    changeMocks.preview.mockRejectedValue(
      new TransactionRejectedError("OP_INVALID", [{ rule: "path_not_resolved", message: "Không resolve được actors[id=A08]", path: "actors[id=A08]" }])
    )

    const session = await sendMessageAndGetResponse(PROJECT, String(plain._id), "Xoá actor A08", "overview", USER)

    const last = session.messages[session.messages.length - 1] as { content: string }
    const payload = JSON.parse(last.content) as { kind: string; reply: string }
    expect(payload.kind).toBe("change_error")
    expect(payload.reply).toBe("Không tìm thấy mục cần sửa. Hãy nói rõ tên mục (ví dụ: màn “Đặt lịch”, chức năng “Huỷ lịch”).")
    expect(payload.reply).not.toContain("actors[")
  })
})

describe("FLF-244 — ngữ cảnh CHAT: không lặp tin hiện tại, có tóm tắt hội thoại", () => {
  const USER = "650000000000000000000010"
  const reply = { data: { reply: "ok", questions: [] }, tokensUsed: {}, cost: 0 }
  const historyOf = () => (aiMocks.executeAiAction.mock.calls[0][1] as { promptVariables: { chat_history: string; input_text: string } }).promptVariables

  it("chat_history không chứa tin đang gửi (tin đó chỉ nằm ở input_text)", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    aiMocks.executeAiAction.mockResolvedValue(reply)

    await sendMessageAndGetResponse(PROJECT, String(plain._id), "Câu hỏi đầu tiên?", "overview", USER)
    await sendMessageAndGetResponse(PROJECT, String(plain._id), "Câu hỏi thứ hai?", "overview", USER)

    const second = aiMocks.executeAiAction.mock.calls[1][1] as { promptVariables: { chat_history: string; input_text: string } }
    expect(second.promptVariables.input_text).toBe("Câu hỏi thứ hai?")
    expect(second.promptVariables.chat_history).toContain("User: Câu hỏi đầu tiên?")
    expect(second.promptVariables.chat_history).not.toContain("Câu hỏi thứ hai?")
  })

  it("có Spine ⇒ chat_history mở đầu bằng tóm tắt (ý tưởng, điều đã chốt)", async () => {
    await createChatSession(PROJECT)
    const plain = await createChatSession(PROJECT)
    spineRepoMocks.get.mockResolvedValue({
      projectId: PROJECT,
      spine_version: 7,
      progress: { current_step: null },
      project: { vision: "Ứng dụng đặt lịch cắt tóc", goals: [] },
      decisions: [],
      addendum: []
    })
    aiMocks.executeAiAction.mockResolvedValue(reply)

    await sendMessageAndGetResponse(PROJECT, String(plain._id), "Tài liệu đang thiếu gì?", "overview", USER)

    expect(historyOf().chat_history).toMatch(/^Tóm tắt hội thoại trước: Ý tưởng: Ứng dụng đặt lịch cắt tóc/)
  })
})
