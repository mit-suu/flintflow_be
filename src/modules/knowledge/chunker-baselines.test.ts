import { describe, it, expect } from "vitest"
import { chunkDocument, CHARS_PER_TOKEN, type KnowledgeDoc } from "./chunker.js"
import { FIXED_CHUNK_TOKENS, FIXED_OVERLAP_TOKENS, fixedSizeChunks, headingChunksNoHeader } from "./chunker-baselines.js"

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ")

const doc = (body: string): KnowledgeDoc => ({
  corpus: "skills",
  doc_id: "demo",
  source: "demo",
  source_kind: "internal_skill",
  topic: "action",
  description: "d",
  status: "verified",
  applies_to: [],
  body
})

describe("fixedSizeChunks (chỉ eval)", () => {
  it("cửa sổ ~512 token, chồng ~64 token, span trỏ đúng chữ trên body và phủ hết body", () => {
    const body = words(1500)
    const chunks = fixedSizeChunks(doc(body))
    expect(chunks.length).toBeGreaterThan(2)
    const width = FIXED_CHUNK_TOKENS * CHARS_PER_TOKEN
    for (const c of chunks) {
      expect(body.slice(c.span[0], c.span[1]).trim()).toBe(c.text)
      expect(c.span[1] - c.span[0]).toBeLessThanOrEqual(width)
      expect(c.embed_text).toBe(c.text)
    }
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i - 1]!.span[1] - chunks[i]!.span[0]
      expect(overlap).toBeGreaterThan(0)
      expect(overlap).toBeLessThanOrEqual(FIXED_OVERLAP_TOKENS * CHARS_PER_TOKEN)
    }
    expect(chunks[chunks.length - 1]!.span[1]).toBe(body.length)
    expect(chunks.map((c) => c.chunk_id)).toEqual(chunks.map((_, i) => `demo#fixed-${i + 1}`))
  })

  it("overlap ≥ size bị từ chối", () => {
    expect(() => fixedSizeChunks(doc("x"), 64, 64)).toThrow()
  })
})

describe("headingChunksNoHeader (chỉ eval)", () => {
  it("cùng chunk với chunker chính, embed_text không có header", () => {
    const d = doc(["## Rules", words(200), "## Output", words(200)].join("\n"))
    const main = chunkDocument(d).chunks
    const bare = headingChunksNoHeader(d)
    expect(bare.map((c) => c.chunk_id)).toEqual(main.map((c) => c.chunk_id))
    expect(bare.map((c) => c.span)).toEqual(main.map((c) => c.span))
    for (const c of bare) expect(c.embed_text).toBe(c.text)
  })
})
