import { afterEach, describe, it, expect } from "vitest"
import mongoose from "mongoose"
import { env } from "../config/env.js"
import { formatIngestSummary, parseIngestArgs, runIngest } from "./ingest-knowledge.js"

const original = env.EMBEDDING_PROVIDER
afterEach(() => {
  env.EMBEDDING_PROVIDER = original
})

describe("ingest-knowledge — cờ", () => {
  it("mặc định dir = KNOWLEDGE_CORPUS_DIR, corpus = tên thư mục; nhận --dir --corpus --dry-run", () => {
    expect(parseIngestArgs([])).toEqual({ dir: env.KNOWLEDGE_CORPUS_DIR, corpus: "skills", dryRun: false })
    expect(parseIngestArgs(["--dir", "x/standards", "--dry-run"])).toEqual({ dir: "x/standards", corpus: "standards", dryRun: true })
    expect(parseIngestArgs(["--dir", "assets/skills", "--corpus", "skills"]).corpus).toBe("skills")
    expect(() => parseIngestArgs(["--force"])).toThrow(/Cờ không nhận ra/)
  })
})

describe("ingest-knowledge — chạy", () => {
  it("--dry-run in thống kê chunk, không nối Mongo, không cần embedding", async () => {
    env.EMBEDDING_PROVIDER = "off"
    const lines: string[] = []
    const code = await runIngest({ dir: "assets/skills", corpus: "skills", dryRun: true }, (l) => lines.push(l))
    expect(code).toBe(0)
    expect(lines.join("\n")).toMatch(/tài liệu: 40 · chunk: \d+ · token .* p50 \d+, p90 \d+, max \d+/)
    expect(lines.join("\n")).toMatch(/gộp \(chunk chứa ≥ 2 section\): \d+ · section bị cắt: \d+/)
    expect(lines[lines.length - 1]).toMatch(/dry-run/)
    expect(mongoose.connection.readyState).toBe(0)
  })

  it("chạy thật khi embedding tắt ⇒ từ chối với thông báo rõ, mã thoát 1, không nối Mongo", async () => {
    env.EMBEDDING_PROVIDER = "off"
    const lines: string[] = []
    expect(await runIngest({ dir: "assets/skills", corpus: "skills", dryRun: false }, (l) => lines.push(l))).toBe(1)
    expect(lines[lines.length - 1]).toMatch(/Embedding chưa bật/)
    expect(mongoose.connection.readyState).toBe(0)
  })

  it("tóm tắt ingest đủ số chunk / embed / giữ / xoá / token", () => {
    expect(formatIngestSummary({ corpus: "skills", model: "m", chunks: 10, embedded: 2, unchanged: 8, deleted: 1, embedded_tokens: 300, tokens: 2000 })).toBe(
      "corpus skills (model m): 10 chunk · embed 2 (~300 token) · giữ 8 · xoá 1 · tổng ~2000 token chữ"
    )
  })
})
