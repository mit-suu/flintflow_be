/**
 * Plumbing của `eval-knowledge.ts` chạy offline: embedding `mock` (túi từ băm) + provider LLM `mock` — không gọi mạng,
 * không nối Mongo. Số đo ở đây vô nghĩa về chất lượng; test chỉ chứng minh hai chế độ chạy hết và ghi đúng báo cáo.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, it, expect, vi } from "vitest"

// env.ts đọc process.env một lần lúc import ⇒ đặt trước mọi import; trả lại giá trị cũ khi xong file
const saved = vi.hoisted(() => {
  const before = { EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER, AI_PROVIDER_OVERRIDE: process.env.AI_PROVIDER_OVERRIDE }
  process.env.EMBEDDING_PROVIDER = "mock"
  process.env.AI_PROVIDER_OVERRIDE = "mock"
  return before
})

import { CHUNKERS, DEFAULT_QUESTIONS_FILE, parseEvalArgs, runKnowledgeEval, type EvalOptions } from "./eval-knowledge.js"

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "keval-"))
afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const options = (over: Partial<EvalOptions>): EvalOptions => ({
  ...parseEvalArgs(["--retrieval-only"]),
  outDir,
  log: () => {},
  ...over
})

describe("eval-knowledge — cờ", () => {
  it("bắt buộc đúng một chế độ; --mode chỉ nhận rag|norag|both", () => {
    expect(() => parseEvalArgs([])).toThrow(/Chọn đúng một chế độ/)
    expect(() => parseEvalArgs(["--retrieval-only", "--answers"])).toThrow(/Chọn đúng một chế độ/)
    expect(() => parseEvalArgs(["--answers", "--mode", "x"])).toThrow(/--mode/)
    expect(parseEvalArgs(["--answers", "--mode", "rag", "--ids", "q1,q2", "--min-score", "0.5", "--label", "x"])).toMatchObject({
      answers: true,
      mode: "rag",
      ids: ["q1", "q2"],
      minScore: 0.5,
      label: "x",
      questionsFile: DEFAULT_QUESTIONS_FILE
    })
  })
})

describe("eval-knowledge — offline với mock", () => {
  it("--retrieval-only: đủ 9 ô ablation, quét ngưỡng 0,40–0,85, ước lượng không có lượt LLM, ghi .md + .json", async () => {
    const lines: string[] = []
    const { report, markdown, files } = await runKnowledgeEval(options({ label: "plumbing-retrieval", log: (l) => lines.push(l) }))
    expect(report.retrieval!.ablation).toHaveLength(9)
    expect(new Set(report.retrieval!.ablation.map((c) => c.chunker))).toEqual(new Set(CHUNKERS))
    for (const cell of report.retrieval!.ablation) expect(cell.metrics.n).toBe(32)
    expect(report.retrieval!.abstention.rows).toHaveLength(46)
    expect(report.retrieval!.abstention.best).not.toBeNull()
    expect(report.retrieval!.abstention.tops).toHaveLength(40)
    expect(report.estimate.llm_calls).toBe(0)
    expect(report.estimate.embedding_texts).toBeGreaterThan(40)
    expect(report.questions).toMatchObject({ total: 40, in_corpus: 32, out_of_corpus: 8 })
    // Ước lượng in TRƯỚC khi chạy
    expect(lines.findIndex((l) => l.startsWith("Ước lượng"))).toBeLessThan(lines.findIndex((l) => l.startsWith("…")))
    expect(markdown).toContain("| heading+header | hybrid |")
    expect(fs.readFileSync(files.md, "utf-8")).toBe(markdown)
    expect(JSON.parse(fs.readFileSync(files.json, "utf-8")).label).toBe("plumbing-retrieval")
    expect(path.basename(files.md)).toMatch(/^knowledge-eval-plumbing-retrieval-\d{4}-\d{2}-\d{2}T.*\.md$/)
  })

  it("--answers trên 3 câu: RAG (answer.service) + no-RAG + judge đều chạy qua mock, có tổng hợp", async () => {
    const { report, markdown } = await runKnowledgeEval(
      options({ retrievalOnly: false, answers: true, mode: "both", ids: ["q01", "q09", "q33"], minScore: 0.05, label: "plumbing-answers" })
    )
    const answers = report.answers!
    expect(answers.details.map((d) => `${d.id}:${d.mode}`)).toEqual(["q01:rag", "q01:norag", "q09:rag", "q09:norag", "q33:rag", "q33:norag"])
    expect(answers.details.every((d) => !d.error)).toBe(true)
    // Mock trả lời có trích `K1` ⇒ hậu kiểm giữ được trích dẫn
    const rag = answers.details.find((d) => d.id === "q01" && d.mode === "rag")!
    expect(rag.grounded).toBe(true)
    expect(rag.citations![0]!.ref).toBe("K1")
    expect(rag.judge).toMatchObject({ correct: 0.5, abstained: false })
    expect(answers.aggregate.rag).toMatchObject({ n: 3, in_corpus: 2, out_of_corpus: 1, citation_validity: 1, errors: 0 })
    expect(answers.aggregate.norag).toMatchObject({ n: 3, errors: 0 })
    expect(report.estimate.llm_calls).toBe(12)
    expect(markdown).toContain("## Câu trả lời")
  })
})
