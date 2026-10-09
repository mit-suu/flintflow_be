import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, vi, afterEach } from "vitest"
import { CACHE_FLUSH_EVERY, cacheKey, createEmbeddingCache } from "./eval-embedding-cache.js"

const dirs: string[] = []
const tmpFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kcache-"))
  dirs.push(dir)
  return path.join(dir, "cache.jsonl")
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const fakeEmbedder = () => vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 1]))

describe("cache embedding của eval", () => {
  it("text đã có không gọi provider; giữ thứ tự, text trùng chỉ embed một lần", async () => {
    const embed = fakeEmbedder()
    const cache = createEmbeddingCache(null, embed, "m")
    expect(await cache.embed(["aa", "b", "aa"], "RETRIEVAL_DOCUMENT")).toEqual([[2, 1], [1, 1], [2, 1]])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0]![0]).toEqual(["aa", "b"])
    await cache.embed(["b"], "RETRIEVAL_DOCUMENT")
    expect(embed).toHaveBeenCalledTimes(1)
    // cùng chữ khác taskType là khoá khác
    await cache.embed(["b"], "RETRIEVAL_QUERY")
    expect(embed).toHaveBeenCalledTimes(2)
    expect(cache.stats()).toMatchObject({ misses: 3, size: 3 })
  })

  it("ghi file theo nhóm — quota hỏng giữa chừng vẫn giữ phần đã embed; lượt sau đọc lại file", async () => {
    const file = tmpFile()
    const texts = Array.from({ length: CACHE_FLUSH_EVERY + 5 }, (_, i) => `t${i}`)
    let calls = 0
    const flaky = vi.fn(async (batch: string[]) => {
      if (++calls === 2) throw new Error("429 quota ngày")
      return batch.map(() => [1, 0])
    })
    await expect(createEmbeddingCache(file, flaky, "m").embed(texts, "RETRIEVAL_DOCUMENT")).rejects.toThrow("429")
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(CACHE_FLUSH_EVERY)

    const embed = fakeEmbedder()
    const again = createEmbeddingCache(file, embed, "m")
    await again.embed(texts, "RETRIEVAL_DOCUMENT")
    expect(embed.mock.calls[0]![0]).toEqual(texts.slice(CACHE_FLUSH_EVERY))
  })

  it("seed không ghi đè khoá đã có; dòng ghi dở trong file bị bỏ qua", async () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${JSON.stringify({ k: cacheKey("m", "RETRIEVAL_DOCUMENT", "x"), v: [9] })}\n{"k":"dở`)
    const embed = fakeEmbedder()
    const cache = createEmbeddingCache(file, embed, "m")
    expect(cache.seed([{ text: "x", taskType: "RETRIEVAL_DOCUMENT", vector: [0] }, { text: "y", taskType: "RETRIEVAL_DOCUMENT", vector: [7] }])).toBe(1)
    expect(await cache.embed(["x", "y"], "RETRIEVAL_DOCUMENT")).toEqual([[9], [7]])
    expect(embed).not.toHaveBeenCalled()
  })
})
