import { beforeEach, describe, it, expect, vi } from "vitest"

const { executeAiAction, retrieveKnowledge } = vi.hoisted(() => ({ executeAiAction: vi.fn(), retrieveKnowledge: vi.fn() }))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction }))
vi.mock("./retrieve.js", () => ({ retrieveKnowledge }))

import { ActionType } from "../../shared/ai/ai-action.types.js"
import {
  ABSTAIN_REPLY,
  answerFromRetrieval,
  answerKnowledgeQuestion,
  formatChunksForPrompt,
  labelChunks,
  postCheckAnswer,
  type KnowledgeInvoke
} from "./answer.service.js"
import type { RetrievalResult, RetrievedChunk } from "./retrieve.js"

const chunk = (id: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunk_id: id,
  source: id.split("#")[0]!,
  source_kind: "internal_skill",
  section: "Rules",
  status: "verified",
  text: `text of ${id}`,
  context_text: `context of ${id}`,
  rrf: 0.03,
  ...over
})

const retrieval = (chunks: RetrievedChunk[], over: Partial<RetrievalResult> = {}): RetrievalResult => ({
  chunks,
  top_vector_score: 0.8,
  backend: "memory",
  abstain: false,
  ...over
})

beforeEach(() => {
  executeAiAction.mockReset()
  retrieveKnowledge.mockReset()
})

describe("formatChunksForPrompt", () => {
  it("nhãn K1..Kn theo thứ tự truy hồi; skill nội bộ ghi rõ là hướng dẫn nội bộ FlintFlow, chữ là context_text", () => {
    const labelled = labelChunks([chunk("gate-check#caps"), chunk("iso#5-2", { source_kind: "standard", section: "5.2" })])
    const text = formatChunksForPrompt(labelled)
    expect(text).toContain("[K1] source: gate-check · section: Rules · kind: internal_skill (FlintFlow internal guideline)\ncontext of gate-check#caps")
    expect(text).toContain("[K2] source: iso · section: 5.2 · kind: standard (external standard)")
  })
})

describe("postCheckAnswer", () => {
  const labelled = labelChunks([chunk("a#x"), chunk("b#y"), chunk("c#z")])

  it("bỏ nhãn không có trong tập truy hồi, bỏ ý không còn nhãn hợp lệ; citations chỉ gồm nhãn được trích, theo thứ tự", () => {
    const out = postCheckAnswer(
      {
        grounded: true,
        answer: "Fact one [K2]. Fact two [K9]. Fact three [k1].",
        claims: [
          { text: "Fact one", refs: ["K2", "K9"] },
          { text: "Fact two", refs: ["K9"] },
          { text: "Fact three", refs: ["[k1]", "K2"] }
        ]
      },
      labelled,
      "en"
    )
    expect(out.grounded).toBe(true)
    expect(out.claims).toEqual([
      { text: "Fact one", refs: ["K2"] },
      { text: "Fact three", refs: ["K1", "K2"] }
    ])
    expect(out.citations).toEqual([
      { ref: "K2", chunk_id: "b#y", source: "b", section: "Rules", source_kind: "internal_skill" },
      { ref: "K1", chunk_id: "a#x", source: "a", section: "Rules", source_kind: "internal_skill" }
    ])
    // Nhãn bịa trong câu trả lời bị gỡ, nhãn thật giữ nguyên
    expect(out.answer).toBe("Fact one [K2]. Fact two. Fact three [k1].")
  })

  it("model tự nói không đủ căn cứ ⇒ câu từ chối cố định theo ngôn ngữ, không citation", () => {
    const out = postCheckAnswer({ grounded: false, answer: "Not covered", claims: [] }, labelled, "vi")
    expect(out).toEqual({ grounded: false, answer: ABSTAIN_REPLY.vi, claims: [], citations: [], abstain_reason: "model_ungrounded" })
  })

  it("grounded nhưng không ý nào còn nhãn hợp lệ ⇒ từ chối (no_valid_claims)", () => {
    const out = postCheckAnswer({ grounded: true, answer: "Made up", claims: [{ text: "x", refs: ["K7"] }] }, labelled, "en")
    expect(out.grounded).toBe(false)
    expect(out.answer).toBe(ABSTAIN_REPLY.en)
    expect(out.abstain_reason).toBe("no_valid_claims")
  })
})

describe("answerFromRetrieval", () => {
  it("retrieval báo từ chối ⇒ câu cố định, KHÔNG gọi model, cost 0", async () => {
    const invoke = vi.fn<KnowledgeInvoke>()
    const out = await answerFromRetrieval("q", retrieval([chunk("a#x")], { abstain: true, top_vector_score: 0.2 }), "vi", invoke)
    expect(invoke).not.toHaveBeenCalled()
    expect(out).toMatchObject({ grounded: false, answer: ABSTAIN_REPLY.vi, abstain_reason: "low_score", cost: 0, tokensUsed: null })
    expect(out.retrieval).toEqual({ backend: "memory", top_vector_score: 0.2, chunk_ids: ["a#x"] })
  })

  it("chunk placeholder không bao giờ vào prompt; còn toàn placeholder ⇒ từ chối không gọi model", async () => {
    const invoke = vi.fn<KnowledgeInvoke>(async () => ({ data: { grounded: true, answer: "A [K1]", claims: [{ text: "A", refs: ["K1"] }] }, cost: 2 }))
    const out = await answerFromRetrieval("q", retrieval([chunk("draft#p", { status: "placeholder" }), chunk("a#x")]), "en", invoke)
    const vars = invoke.mock.calls[0]![0].promptVariables as { question: string; chunks: string }
    expect(vars.question).toBe("q")
    expect(vars.chunks).not.toContain("draft#p")
    expect(vars.chunks).toContain("[K1] source: a")
    expect(invoke.mock.calls[0]![0].replyLanguage).toBe("en")
    expect(out.citations.map((c) => c.chunk_id)).toEqual(["a#x"])
    expect(out.cost).toBe(2)

    // Hai phần cùng section mở rộng ra cùng chữ ⇒ chỉ một nhãn
    const twin = vi.fn<KnowledgeInvoke>(async () => ({ data: { grounded: false, answer: "", claims: [] } }))
    await answerFromRetrieval("q", retrieval([chunk("a#r/1", { context_text: "whole" }), chunk("a#r/2", { context_text: "whole" })]), "en", twin)
    expect((twin.mock.calls[0]![0].promptVariables as { chunks: string }).chunks).not.toContain("[K2]")

    const onlyPlaceholder = vi.fn<KnowledgeInvoke>()
    expect((await answerFromRetrieval("q", retrieval([chunk("draft#p", { status: "placeholder" })]), "en", onlyPlaceholder)).grounded).toBe(false)
    expect(onlyPlaceholder).not.toHaveBeenCalled()
  })
})

describe("answerKnowledgeQuestion", () => {
  it("truy hồi corpus skills rồi gọi executeAiAction(KNOWLEDGE_ANSWER) với project/user của lượt chat", async () => {
    retrieveKnowledge.mockResolvedValue(retrieval([chunk("gate-check#caps")]))
    executeAiAction.mockResolvedValue({
      data: { grounded: true, answer: "8 calls [K1]", claims: [{ text: "8 calls per step", refs: ["K1"] }] },
      cost: 2,
      tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    })
    const out = await answerKnowledgeQuestion("How many calls?", { projectId: "p1", userId: "u1", language: "en" })
    expect(retrieveKnowledge).toHaveBeenCalledWith("How many calls?", { corpus: "skills" })
    expect(executeAiAction).toHaveBeenCalledWith(ActionType.KNOWLEDGE_ANSWER, expect.objectContaining({ replyLanguage: "en" }), "p1", "u1")
    expect(out).toMatchObject({ grounded: true, cost: 2, tokensUsed: { totalTokens: 15 } })
    expect(out.citations).toEqual([{ ref: "K1", chunk_id: "gate-check#caps", source: "gate-check", section: "Rules", source_kind: "internal_skill" }])
  })
})
