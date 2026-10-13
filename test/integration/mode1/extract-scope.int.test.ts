/**
 * I-4: known_keys theo phạm vi lượt gọi — prompt không phình theo phần tử không liên quan (provider giả ghi prompt).
 * Gọi `runExtraction` trực tiếp như `extract.service.int.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockCalls, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"

/** Prompt I-4 (chữ) theo section, theo thứ tự gọi. */
let prompts: { section: string; prompt: string }[] = []
const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"

beforeEach(() => {
  resetMockLlm()
  prompts = []
  mockOverrides.next = (prompt) => {
    if (prompt.includes("# Import Extract")) prompts.push({ section: sectionOf(prompt), prompt })
    return fakeMode1(prompt)
  }
})

/** 150 business rule không mục nào khác nhắc tới — trước đây vào known_keys của mọi lượt I-4. */
const UNRELATED_RULES = Array.from({ length: 150 }, (_, i) => [`BR-${String(i + 2).padStart(3, "0")}`, `Rule number ${i + 2} about invoices and refunds.`])

const knownKeysOf = (prompt: string): string => {
  const start = prompt.indexOf("never create a duplicate:")
  const end = prompt.indexOf("- Blocks of the section")
  return prompt.slice(start, end)
}

const run = async (srs: Parameters<typeof importAtExtracting>[0] = {}) => {
  prompts = []
  const ctx = await importAtExtracting(srs)
  const out = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  const fields = (await ExtractionDraft.find({ import_id: ctx.importId }).lean()).flatMap((d) => d.fields.map((f) => `${d.section_id}|${f.path}`)).sort()
  return { out, prompts: [...prompts], fields }
}

describe("I-4 — known_keys theo phạm vi", () => {
  it("thêm 150 business rule không liên quan ⇒ prompt mỗi lượt chữ không dài thêm; mã được nhắc vẫn có trong known_keys", async () => {
    const base = await run()
    const big = await run({ srs: { extraRules: UNRELATED_RULES } })
    expect(big.prompts.map((p) => p.section)).toEqual(base.prompts.map((p) => p.section))
    const total = (ps: { prompt: string }[], part: (p: string) => string = (p) => p) => ps.reduce((n, p) => n + part(p.prompt).length, 0)
    console.info(
      `[I-4 known_keys] fixture: ${base.prompts.length} lượt chữ, prompt ${total(base.prompts)} ký tự (known_keys ${total(base.prompts, knownKeysOf)}); ` +
        `+150 BR: prompt ${total(big.prompts)} ký tự (known_keys ${total(big.prompts, knownKeysOf)})`
    )
    base.prompts.forEach((p, i) => expect(big.prompts[i].prompt.length, p.section).toBe(p.prompt.length))
    // mục chức năng 3.2.1 nhắc UC-01 ⇒ use case đó có trong known_keys; BR không ai nhắc thì không
    const fn = big.prompts.find((p) => p.prompt.includes("(UC-01)") && p.section.startsWith("function:"))!
    expect(knownKeysOf(fn.prompt)).toContain("UC-01")
    for (const p of big.prompts) expect(knownKeysOf(p.prompt), p.section).not.toContain("BR-050")
    // khớp phần tử ở code vẫn dùng toàn bộ phần tử đã biết ⇒ cùng tập field (thêm đúng các field của rule mới)
    const extra = big.fields.filter((f) => !base.fields.includes(f))
    expect(extra.every((f) => f.startsWith("fixed:5.1|business_rules["))).toBe(true)
    expect(base.fields.every((f) => big.fields.includes(f))).toBe(true)
    expect(mockCalls.length).toBeGreaterThan(0)
  }, 60_000)
})
