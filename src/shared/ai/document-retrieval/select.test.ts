import { describe, expect, it } from "vitest"
import { CHUNK_LABEL_TOKENS, chunkCost, headChunks, pinnedChunkIds, selectChunks, type SelectableChunk } from "./select.js"

const chunk = (id: string, tokens: number, titles: string[] = []): SelectableChunk => ({
  id,
  ordinal: Number(id.slice(1)),
  heading_path: titles,
  titles,
  p_start: 0,
  p_end: 0,
  paragraphs: [id],
  tokens
})

const CHUNKS = [chunk("c0", 100), chunk("c1", 100, ["2.1 Actors"]), chunk("c2", 100), chunk("c3", 100, ["4.2.3 Hiệu năng"]), chunk("c4", 100)]
const COST = 100 + CHUNK_LABEL_TOKENS

describe("pinnedChunkIds (FLF-393)", () => {
  it("khớp tiêu đề section sau khi bỏ số mục, không phân biệt dấu / hoa thường", () => {
    expect(pinnedChunkIds(CHUNKS, ["Actors", "Tác nhân"])).toEqual(["c1"])
    expect(pinnedChunkIds(CHUNKS, ["Performance", "hieu nang"])).toEqual(["c3"])
    expect(pinnedChunkIds(CHUNKS, [])).toEqual([])
    expect(pinnedChunkIds(CHUNKS, ["Glossary"])).toEqual([])
  })
})

describe("selectChunks (FLF-393)", () => {
  const ranked = [
    { id: "c4", score: 9 },
    { id: "c0", score: 5 },
    { id: "c2", score: 1 }
  ]

  it("top-k theo điểm, trả về theo thứ tự tài liệu", () => {
    const out = selectChunks({ chunks: CHUNKS, ranked, maxTokens: 10_000, topK: 2 })
    expect(out.map((c) => c.id)).toEqual(["c0", "c4"])
  })

  it("trần token cứng: không bao giờ vượt, chunk điểm cao vào trước", () => {
    const out = selectChunks({ chunks: CHUNKS, ranked, maxTokens: COST * 2 - 1, topK: 10 })
    expect(out.map((c) => c.id)).toEqual(["c4"])
    expect(out.reduce((sum, c) => sum + chunkCost(c), 0)).toBeLessThanOrEqual(COST * 2 - 1)
    expect(selectChunks({ chunks: CHUNKS, ranked, maxTokens: COST - 1, topK: 10 })).toEqual([])
  })

  it("chunk không vừa bị bỏ qua, chunk nhỏ hơn phía sau vẫn được lấy", () => {
    const chunks = [chunk("c0", 900), chunk("c1", 50)]
    const out = selectChunks({ chunks, ranked: [{ id: "c0", score: 9 }, { id: "c1", score: 1 }], maxTokens: 200, topK: 5 })
    expect(out.map((c) => c.id)).toEqual(["c1"])
  })

  it("chunk ghim đi trước và không tính vào top-k", () => {
    const out = selectChunks({ chunks: CHUNKS, ranked, pinnedIds: ["c1", "c3"], maxTokens: 10_000, topK: 1 })
    expect(out.map((c) => c.id)).toEqual(["c1", "c3", "c4"])
  })

  it("ghim nhiều hơn ngân sách ⇒ chunk ghim được BM25 chấm cao hơn vào trước", () => {
    const out = selectChunks({ chunks: CHUNKS, ranked: [{ id: "c3", score: 4 }], pinnedIds: ["c1", "c3"], maxTokens: COST, topK: 5 })
    expect(out.map((c) => c.id)).toEqual(["c3"])
  })

  it("id lạ bị bỏ; không có gì ⇒ rỗng", () => {
    expect(selectChunks({ chunks: CHUNKS, ranked: [{ id: "zz", score: 1 }], pinnedIds: ["yy"], maxTokens: 1000, topK: 5 })).toEqual([])
  })
})

describe("headChunks", () => {
  it("lấy từ đầu tới khi hết ngân sách", () => {
    expect(headChunks(CHUNKS, COST * 2).map((c) => c.id)).toEqual(["c0", "c1"])
    expect(headChunks(CHUNKS, 10)).toEqual([])
  })
})
