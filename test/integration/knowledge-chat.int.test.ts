/**
 * FLF-267 — câu hỏi tri thức trong chat qua HTTP thật: cờ `knowledge` (kiểm kiểu, 409 khi tắt), tin AI lưu trong phiên
 * (`{ reply, questions: [], grounded, citations[] }`), từ chối không gọi model / không trừ credit, route stream phát đúng
 * một sự kiện `finish`, và cờ đi trước lệnh sửa. Embedding `mock` + vector `memory` đặt trong file; model giả ở tầng
 * `llm.router` (lượt KNOWLEDGE_ANSWER đi `executeAiAction` cả ở route stream nên mock này phủ được).
 */
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { ChatSession } from "../../src/modules/project/chat-session.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { chunkCorpus } from "../../src/modules/knowledge/chunker.js"
import { loadCorpus } from "../../src/modules/knowledge/corpus.js"
import { ingestChunks } from "../../src/modules/knowledge/ingest.js"
import { ABSTAIN_REPLY } from "../../src/modules/knowledge/answer.service.js"
import { invalidateMemoryIndex } from "../../src/modules/knowledge/vector-backend.js"
import { parseSse, seedFixture, type SeededFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"

const saved = {
  enabled: env.KNOWLEDGE_ENABLED,
  provider: env.EMBEDDING_PROVIDER,
  backend: env.KNOWLEDGE_VECTOR_BACKEND,
  minScore: env.KNOWLEDGE_MIN_SCORE
}
const skillChunks = chunkCorpus(loadCorpus("assets/skills", { corpus: "skills" })).chunks
const CAPS_QUESTION = "How many model calls per step and how many regenerates per step are allowed?"

const messages = (f: SeededFixture, stream = false) => `/api/v1/projects/${f.projectId}/chats/${f.sessionId}/messages${stream ? "/stream" : ""}`
const bearer = (f: SeededFixture) => ({ Authorization: `Bearer ${f.token}` })
const lastAi = async (f: SeededFixture) => {
  const session = await ChatSession.findById(f.sessionId).lean()
  const ai = [...(session?.messages ?? [])].reverse().find((m) => m.role === "ai")
  return ai ? (JSON.parse(ai.content) as Record<string, unknown>) : null
}
const balance = async (f: SeededFixture) => (await CreditWallet.findOne({ organizationId: f.orgId }).lean())!.balance

beforeEach(async () => {
  env.KNOWLEDGE_ENABLED = true
  env.EMBEDDING_PROVIDER = "mock"
  env.KNOWLEDGE_VECTOR_BACKEND = "memory"
  env.KNOWLEDGE_MIN_SCORE = 0.2
  invalidateMemoryIndex()
  resetMockLlm()
  // Model trả lời có trích K1 và một nhãn bịa K99 (phải bị hậu kiểm bỏ)
  mockOverrides.next = (prompt) =>
    prompt.includes("# Knowledge Answer")
      ? JSON.stringify({ grounded: true, answer: "Mỗi bước tối đa 8 lượt gọi model [K1].", claims: [{ text: "Tối đa 8 lượt gọi model mỗi bước.", refs: ["K1", "K99"] }] })
      : undefined
  await ingestChunks(skillChunks, { corpus: "skills" })
})

afterAll(() => {
  env.KNOWLEDGE_ENABLED = saved.enabled
  env.EMBEDDING_PROVIDER = saved.provider
  env.KNOWLEDGE_VECTOR_BACKEND = saved.backend
  env.KNOWLEDGE_MIN_SCORE = saved.minScore
})

describe("FLF-267 chat — cờ knowledge", () => {
  it("KNOWLEDGE_ENABLED tắt ⇒ 409 KNOWLEDGE_DISABLED, không ghi tin nào vào phiên", async () => {
    env.KNOWLEDGE_ENABLED = false
    const f = await seedFixture("minimal")
    for (const stream of [false, true]) {
      const res = await request(app).post(messages(f, stream)).set(bearer(f)).send({ content: CAPS_QUESTION, step: "chat", knowledge: true })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe("KNOWLEDGE_DISABLED")
    }
    expect((await ChatSession.findById(f.sessionId).lean())!.messages).toHaveLength(0)
  })

  it("knowledge không phải boolean ⇒ 400 VALIDATION_ERROR", async () => {
    const f = await seedFixture("minimal")
    const res = await request(app).post(messages(f)).set(bearer(f)).send({ content: CAPS_QUESTION, step: "chat", knowledge: "true" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("FLF-267 chat — trả lời có căn cứ", () => {
  it("route JSON: tin AI = { reply, questions: [], grounded: true, citations[] } chỉ gồm nhãn thật; trừ 2 credit", async () => {
    const f = await seedFixture("minimal")
    const before = await balance(f)
    const res = await request(app).post(messages(f)).set(bearer(f)).send({ content: CAPS_QUESTION, step: "chat", knowledge: true })
    expect(res.status).toBe(200)
    const ai = await lastAi(f)
    expect(ai).toMatchObject({ reply: "Mỗi bước tối đa 8 lượt gọi model [K1].", questions: [], grounded: true })
    const citations = ai!.citations as { ref: string; chunk_id: string; source_kind: string }[]
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({ ref: "K1", source_kind: "internal_skill" })
    expect(skillChunks.some((c) => c.chunk_id === citations[0]!.chunk_id)).toBe(true)
    expect(mockCalls).toHaveLength(1)
    expect(await balance(f)).toBe(before - 2)
  })

  it("không đủ căn cứ ⇒ câu cố định, grounded: false, KHÔNG gọi model, không trừ credit", async () => {
    const f = await seedFixture("minimal")
    const before = await balance(f)
    const res = await request(app).post(messages(f)).set(bearer(f)).send({ content: "zyxwv qqqqq plugh", step: "chat", knowledge: true })
    expect(res.status).toBe(200)
    expect(await lastAi(f)).toEqual({ reply: ABSTAIN_REPLY.vi, questions: [], grounded: false, citations: [] })
    expect(mockCalls).toHaveLength(0)
    expect(await balance(f)).toBe(before)
  })

  it("model nói không đủ căn cứ ⇒ câu cố định theo ngôn ngữ phiên (tiếng Anh)", async () => {
    mockOverrides.next = (prompt) => (prompt.includes("# Knowledge Answer") ? JSON.stringify({ grounded: false, answer: "no", claims: [] }) : undefined)
    const f = await seedFixture("minimal")
    await request(app).post(messages(f)).set(bearer(f)).send({ content: CAPS_QUESTION, step: "chat", knowledge: true })
    expect(await lastAi(f)).toMatchObject({ reply: ABSTAIN_REPLY.en, grounded: false, citations: [] })
  })

  it("route stream: đúng một sự kiện `finish` mang payload tri thức, không có text-delta", async () => {
    const f = await seedFixture("minimal")
    const res = await request(app).post(messages(f, true)).set(bearer(f)).send({ content: CAPS_QUESTION, step: "chat", knowledge: true })
    expect(res.status).toBe(200)
    const events = parseSse(res.text)
    expect(events.map((e) => e.type)).toEqual(["finish"])
    expect(events[0]!.data).toMatchObject({ grounded: true, questions: [] })
    expect(events[0]!.cost).toBe(2)
    expect(await lastAi(f)).toEqual(events[0]!.data)
  })

  it("cờ knowledge đi trước lệnh sửa: câu dạng lệnh sửa vẫn thành câu trả lời tri thức, không thành bản xem trước", async () => {
    const f = await seedFixture("minimal")
    const res = await request(app).post(messages(f)).set(bearer(f)).send({ content: "Đổi tên actor A01 thành Student", step: "chat", knowledge: true })
    expect(res.status).toBe(200)
    const ai = await lastAi(f)
    expect(ai).toHaveProperty("grounded")
    expect(ai).not.toHaveProperty("kind")
    expect(mockCalls.every((c) => c.kind !== "change")).toBe(true)
  })
})
