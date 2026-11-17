import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { FIXED_FUNCTION_BATCH_SIZE, batchContext, functionBatches, isFixedBatchedStep } from "./step-runner.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withFunctions = (n: number): Spine => {
  const tpl = FIXTURE.functions[0]
  return { ...FIXTURE, functions: Array.from({ length: n }, (_, i) => ({ ...tpl, id: `FN${String(i + 1).padStart(3, "0")}` })) }
}

describe("FLF-433 - S-7.3 chia lô theo function (FLF-413 #7)", () => {
  it("nhiều function ⇒ các lô ≤ cỡ lô, phủ đủ mọi function đúng một lần", () => {
    const spine = withFunctions(27)
    const batches = functionBatches(spine, "S-7.3")
    expect(batches.length).toBe(Math.ceil(27 / FIXED_FUNCTION_BATCH_SIZE))
    expect(batches.every((b) => b.length > 0 && b.length <= FIXED_FUNCTION_BATCH_SIZE)).toBe(true)
    expect(batches.flat().sort()).toEqual(spine.functions.map((f) => f.id).sort())
  })

  it("ít function ⇒ một lô dùng nguyên projection; step khác không chia", () => {
    expect(functionBatches(withFunctions(FIXED_FUNCTION_BATCH_SIZE), "S-7.3")).toEqual([[]])
    expect(functionBatches(withFunctions(30), "S-7.4")).toEqual([[]])
    expect(isFixedBatchedStep("S-7.3")).toBe(true)
    expect(isFixedBatchedStep("S-7.4")).toBe(false)
  })

  it("batchContext chỉ thu hẹp selector functions*, giữ messages", () => {
    const ctx = { projection: { "functions:id,name,abnormal": [{ id: "FN001" }, { id: "FN002" }], messages: [{ id: "M1" }] } } as never
    const out = batchContext(ctx, ["FN002"]) as unknown as { projection: Record<string, unknown[]> }
    expect(out.projection["functions:id,name,abnormal"]).toEqual([{ id: "FN002" }])
    expect(out.projection.messages).toEqual([{ id: "M1" }])
  })
})
