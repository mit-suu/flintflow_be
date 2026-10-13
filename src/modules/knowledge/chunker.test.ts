import { describe, it, expect } from "vitest"
import {
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_TOKENS,
  chunkCorpus,
  chunkDocument,
  chunkStats,
  contextualHeader,
  estimateTokens,
  mergeSmallSections,
  packBlocks,
  slugify,
  splitSections,
  tokenizeMarkdown,
  type KnowledgeDoc
} from "./chunker.js"
import { loadCorpus } from "./corpus.js"

const doc = (body: string, over: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({
  corpus: "skills",
  doc_id: "demo-skill",
  source: "demo-skill",
  source_kind: "internal_skill",
  topic: "content",
  description: "Demo skill for tests",
  status: "verified",
  applies_to: ["S-3.1"],
  body,
  ...over
})

/** Đoạn văn ~n token (ước lượng ký tự/3,5). */
const prose = (tokens: number, word = "lorem"): string => {
  const out: string[] = []
  while (estimateTokens(out.join(" ")) < tokens) out.push(word)
  return out.join(" ")
}

describe("tokenizeMarkdown", () => {
  it("nhận heading, đoạn văn, bảng, code fence, mục danh sách; offset trỏ đúng chữ trong body", () => {
    const body = ["# Title", "", "Intro line one", "intro line two", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "```json", "{ \"x\": 1 }", "", "```", "", "- item one", "- item two"].join("\n")
    const blocks = tokenizeMarkdown(body)
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "table", "code", "list_item", "list_item"])
    expect(blocks[1]!.text).toBe("Intro line one\nintro line two")
    expect(blocks[2]!.text.split("\n")).toHaveLength(3)
    // Dòng trống trong code fence không cắt block
    expect(blocks[3]!.text).toBe("```json\n{ \"x\": 1 }\n\n```")
    for (const b of blocks) expect(body.slice(b.start, b.end)).toBe(b.text)
  })

  it("mục danh sách đánh số giữ dòng nối tiếp thụt lề, danh sách con, code fence thụt lề và dòng trống bên trong", () => {
    const body = [
      "1. **First.** Starts here",
      "   and continues indented.",
      "",
      "   ```json",
      "   { \"a\": 1 }",
      "",
      "   ```",
      "   - nested bullet",
      "2. Second rule",
      "lazy continuation line",
      "",
      "After the list."
    ].join("\n")
    const blocks = tokenizeMarkdown(body)
    expect(blocks.map((b) => [b.type, b.ordinal])).toEqual([
      ["list_item", 1],
      ["list_item", 2],
      ["paragraph", undefined]
    ])
    expect(blocks[0]!.text).toContain("nested bullet")
    expect(blocks[0]!.text).toContain("{ \"a\": 1 }")
    expect(blocks[1]!.text).toBe("2. Second rule\nlazy continuation line")
  })

  it("bỏ dòng chú thích HTML (dấu mốc voice) nhưng giữ chữ giữa hai dấu mốc; bỏ cả chú thích nhiều dòng", () => {
    const body = ["<!-- voice:shared:start -->", "- kept bullet", "<!-- voice:shared:end -->", "<!--", "hidden", "-->", "Visible."].join("\n")
    const blocks = tokenizeMarkdown(body)
    expect(blocks.map((b) => b.text)).toEqual(["- kept bullet", "Visible."])
  })
})

describe("splitSections", () => {
  it("chữ trước `##` đầu là Overview; `###` mang path cha; heading đứng một mình dồn vào section sau", () => {
    const body = ["# Demo", "Intro.", "## Lenses", "### Ambiguity", "Vague words.", "## Rules", "1. One"].join("\n")
    const sections = splitSections(tokenizeMarkdown(body))
    expect(sections.map((s) => s.path)).toEqual([["Overview"], ["Lenses", "Ambiguity"], ["Rules"]])
    // `## Lenses` không thành section rỗng mà đứng đầu section `Lenses › Ambiguity`
    expect(sections[1]!.blocks[0]!.text).toBe("## Lenses")
  })

  it("nhãn Overview đổi được (frontmatter `section` của corpus khác)", () => {
    expect(splitSections(tokenizeMarkdown("Clause text."), "5.2.5 Characteristics")[0]!.path).toEqual(["5.2.5 Characteristics"])
  })
})

describe("gộp section ngắn", () => {
  it(`section < ${CHUNK_MIN_TOKENS} token gộp vào section kế tiếp; section ngắn cuối cùng gộp vào section trước`, () => {
    const body = ["## Context", "Short.", "## Rules", prose(120), "## Output", "JSON only."].join("\n")
    const units = mergeSmallSections(splitSections(tokenizeMarkdown(body)))
    expect(units.map((u) => u.paths.map((p) => p.join(" › ")))).toEqual([["Context", "Rules", "Output"]])
  })

  it("chunk gộp mang nhãn nối heading và id nối slug bằng `+`", () => {
    const body = ["## Context", "Short.", "## Rules", prose(120)].join("\n")
    const [chunk] = chunkDocument(doc(body)).chunks
    expect(chunk!.section).toBe("Context + Rules")
    expect(chunk!.chunk_id).toBe("demo-skill#context+rules")
    expect(chunk!.merged).toBe(true)
    expect(chunk!.heading_path).toEqual(["Context"])
  })
})

describe(`cắt section > ${CHUNK_MAX_TOKENS} token`, () => {
  const rules = ["## Rules", ...Array.from({ length: 12 }, (_, i) => `${i + 1}. ${prose(110, `rule${i + 1}`)}`)].join("\n")

  it("chỉ cắt ở ranh giới block, mỗi phần ≤ trần; nhãn mang dải luật và id mang dải", () => {
    const { chunks } = chunkDocument(doc(rules))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(CHUNK_MAX_TOKENS)
      expect(c.split).toBe(true)
      expect(c.parent_id).toBe("demo-skill#rules")
    }
    expect(chunks[0]!.section).toMatch(/^Rules \(1–\d+\)$/)
    expect(chunks[0]!.chunk_id).toMatch(/^demo-skill#rules\/1-\d+$/)
    // Không mục nào bị cắt đôi: ghép các phần lại ra đủ 12 mục, đúng thứ tự
    const nums = chunks.flatMap((c) => [...c.text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])))
    expect(nums).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(chunks.map((c) => c.part)).toEqual(chunks.map((_, i) => i))
  })

  it("phần không có mục đánh số mang nhãn `part n`", () => {
    const body = ["## Notes", ...Array.from({ length: 8 }, (_, i) => prose(150, `para${i}`))].join("\n\n")
    const { chunks } = chunkDocument(doc(body))
    expect(chunks[0]!.section).toBe("Notes (part 1)")
    expect(chunks[1]!.chunk_id).toBe("demo-skill#notes/part-2")
  })

  it("một block lớn hơn trần (bảng khổng lồ) giữ nguyên và sinh cảnh báo", () => {
    const table = ["| a | b |", "|---|---|", ...Array.from({ length: 120 }, (_, i) => `| row ${i} | ${prose(8, "cell")} |`)].join("\n")
    const { chunks, warnings } = chunkDocument(doc(["## Big table", table].join("\n")))
    const big = chunks.find((c) => c.text.includes("| row 119 |"))!
    expect(big.text).toContain("| row 0 |")
    expect(big.tokens).toBeGreaterThan(CHUNK_MAX_TOKENS)
    expect(warnings.map((w) => w.chunk_id)).toContain(big.chunk_id)
  })

  it("packBlocks: phần đuôi quá nhỏ gộp ngược vào phần trước", () => {
    const blocks = tokenizeMarkdown([prose(300, "a"), prose(300, "b"), prose(20, "c")].join("\n\n"))
    expect(packBlocks(blocks, 500).map((p) => p.length)).toEqual([1, 2])
  })
})

describe("header ngữ cảnh", () => {
  it("chỉ nằm trong embed_text, không nằm trong text hiển thị", () => {
    const [chunk] = chunkDocument(doc(["## Rules", prose(120)].join("\n"))).chunks
    expect(chunk!.embed_text).toBe(`Skill: demo-skill (content) — Demo skill for tests\nSection: Rules\n---\n${chunk!.text}`)
    expect(chunk!.text.startsWith("## Rules")).toBe(true)
  })

  it("corpus chuẩn ngoài dùng `Source:` và loại nguồn", () => {
    expect(contextualHeader({ source: "ISO 29148", source_kind: "standard", topic: "requirements", description: "" }, "5.2")).toBe(
      "Source: ISO 29148 (standard) — requirements\nSection: 5.2\n---\n"
    )
  })
})

describe("slugify", () => {
  it("bỏ dấu, đ ⇒ d, ký tự lạ ⇒ gạch", () => {
    expect(slugify("Điều kiện chốt — KHÔNG")).toBe("dieu-kien-chot-khong")
    expect(slugify("Change instruction (`change_instruction`)")).toBe("change-instruction-change-instruction")
    expect(slugify("***")).toBe("section")
  })
})

describe("corpus skill thật (assets/skills)", () => {
  const docs = loadCorpus("assets/skills", { corpus: "skills" })
  const result = chunkCorpus(docs)

  it("chunk_id duy nhất trên cả corpus và ổn định giữa hai lần chạy", () => {
    const ids = result.chunks.map((c) => c.chunk_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(chunkCorpus(docs).chunks.map((c) => c.chunk_id)).toEqual(ids)
  })

  it("mọi chunk ≤ trần (trừ block đơn có cảnh báo) và ≥ ngưỡng gộp (trừ tài liệu chỉ một chunk)", () => {
    const warned = new Set(result.warnings.map((w) => w.chunk_id))
    const perDoc = new Map<string, number>()
    for (const c of result.chunks) perDoc.set(c.source, (perDoc.get(c.source) ?? 0) + 1)
    for (const c of result.chunks) {
      if (!warned.has(c.chunk_id)) expect(c.tokens, c.chunk_id).toBeLessThanOrEqual(CHUNK_MAX_TOKENS)
      if (perDoc.get(c.source)! > 1 && !c.split) expect(c.tokens, c.chunk_id).toBeGreaterThanOrEqual(CHUNK_MIN_TOKENS)
    }
  })

  it("danh sách Rules dài của draft-to-ops bị cắt theo dải luật; heading Rules ở nhiều skill vẫn phân biệt bằng header", () => {
    const parts = result.chunks.filter((c) => c.parent_id === "draft-to-ops#rules")
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((c) => /^Rules \(\d+(–\d+)?\)$/.test(c.section))).toBe(true)
    const rulesChunks = result.chunks.filter((c) => c.section === "Rules")
    expect(new Set(rulesChunks.map((c) => c.embed_text.split("\n")[0])).size).toBe(rulesChunks.length)
  })

  it("dấu mốc voice không lọt vào chunk", () => {
    expect(result.chunks.some((c) => c.text.includes("<!--"))).toBe(false)
  })

  it("thống kê dry-run khớp danh sách chunk", () => {
    const stats = chunkStats(docs.length, result)
    expect(stats.chunks).toBe(result.chunks.length)
    expect(stats.tokens.max).toBe(Math.max(...result.chunks.map((c) => c.tokens)))
    expect(stats.split_chunks).toBeGreaterThan(stats.split_sections)
  })
})
