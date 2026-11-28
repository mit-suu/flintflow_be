import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { FIXED_FUNCTION_BATCH_SIZE, MAX_FIXED_BATCHES, batchContext, functionBatches, isFixedBatchedStep } from "./step-runner.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withFunctions = (n: number): Spine => {
  const tpl = FIXTURE.functions[0]
  return { ...FIXTURE, functions: Array.from({ length: n }, (_, i) => ({ ...tpl, id: `FN${String(i + 1).padStart(3, "0")}` })) }
}

/** Function không business validation / không abnormal — không có nguồn cho S-7.1 / S-7.3. */
const withoutSource = (f: Spine["functions"][number]): Spine["functions"][number] => ({ ...f, validations: [], abnormal: [] })
/** Function CÓ business validation (nguồn S-7.1). */
const withBusinessValidation = (f: Spine["functions"][number], id: string): Spine["functions"][number] => ({
  ...f,
  validations: [{ id: `${id}-V1`, kind: "business", statement: "x" }]
})

describe("FLF-433 - S-7.3 chia lô theo function (FLF-413 #7)", () => {
  it("nhiều function ⇒ các lô ≤ cỡ lô, phủ đủ mọi function có abnormal đúng một lần", () => {
    const spine = withFunctions(27)
    const batches = functionBatches(spine, "S-7.3")
    expect(batches.length).toBe(Math.ceil(27 / FIXED_FUNCTION_BATCH_SIZE["S-7.3"]))
    expect(batches.every((b) => b.length > 0 && b.length <= FIXED_FUNCTION_BATCH_SIZE["S-7.3"])).toBe(true)
    expect(batches.flat().sort()).toEqual(spine.functions.map((f) => f.id).sort())
  })

  it("ít function ⇒ một lô dùng nguyên projection; step khác không chia", () => {
    expect(functionBatches(withFunctions(FIXED_FUNCTION_BATCH_SIZE["S-7.3"]), "S-7.3")).toEqual([[]])
    expect(functionBatches(withFunctions(30), "S-7.4")).toEqual([[]])
    expect(isFixedBatchedStep("S-7.3")).toBe(true)
    expect(isFixedBatchedStep("S-7.4")).toBe(false)
  })

  it("function không có abnormal không vào lô S-7.3", () => {
    const spine = withFunctions(15)
    const withoutAbnormal = withoutSource(spine.functions[0])
    const mixed = { ...spine, functions: [{ ...withoutAbnormal, id: "FN-NONE" }, ...spine.functions] }
    const batches = functionBatches(mixed, "S-7.3")
    expect(batches.flat()).not.toContain("FN-NONE")
    expect(batches.flat().sort()).toEqual(spine.functions.map((f) => f.id).sort())
  })

  it("batchContext chỉ thu hẹp selector functions*, giữ messages", () => {
    const ctx = { projection: { "functions:id,name,abnormal": [{ id: "FN001" }, { id: "FN002" }], messages: [{ id: "M1" }] } } as never
    const out = batchContext(ctx, ["FN002"]) as unknown as { projection: Record<string, unknown[]> }
    expect(out.projection["functions:id,name,abnormal"]).toEqual([{ id: "FN002" }])
    expect(out.projection.messages).toEqual([{ id: "M1" }])
  })
})

describe("FLF-470 - S-7.1 chia lô theo function (FLF-413 #7, phần còn lại)", () => {
  it("25 function có validation nghiệp vụ ⇒ 3 lô 10/10/5", () => {
    const base = withFunctions(25)
    const spine = { ...base, functions: base.functions.map((f) => withBusinessValidation(f, f.id)) }
    const batches = functionBatches(spine, "S-7.1")
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5])
    expect(batches.flat().sort()).toEqual(spine.functions.map((f) => f.id).sort())
  })

  it("function không có validation nghiệp vụ không vào lô S-7.1", () => {
    const base = withFunctions(12)
    const withSource = base.functions.map((f) => withBusinessValidation(f, f.id))
    const noSource = withoutSource(base.functions[0])
    const spine = { ...base, functions: [{ ...noSource, id: "FN-NONE" }, ...withSource] }
    const batches = functionBatches(spine, "S-7.1")
    expect(batches.flat()).not.toContain("FN-NONE")
    expect(batches.flat().sort()).toEqual(withSource.map((f) => f.id).sort())
  })

  it("dưới cỡ lô gốc ⇒ một lô dùng nguyên projection (một lượt gọi như trước)", () => {
    const base = withFunctions(FIXED_FUNCTION_BATCH_SIZE["S-7.1"])
    const spine = { ...base, functions: base.functions.map((f) => withBusinessValidation(f, f.id)) }
    expect(functionBatches(spine, "S-7.1")).toEqual([[]])
  })

  it("100 function ⇒ không quá MAX_FIXED_BATCHES lô (S-7.1 và S-7.3)", () => {
    const base = withFunctions(100)
    const s71Spine = { ...base, functions: base.functions.map((f) => withBusinessValidation(f, f.id)) }
    const s73Batches = functionBatches(base, "S-7.3")
    const s71Batches = functionBatches(s71Spine, "S-7.1")
    expect(s73Batches.length).toBeLessThanOrEqual(MAX_FIXED_BATCHES)
    expect(s71Batches.length).toBeLessThanOrEqual(MAX_FIXED_BATCHES)
    expect(s71Batches.flat().sort()).toEqual(s71Spine.functions.map((f) => f.id).sort())
  })

  it("S-7.2 / S-7.4 luôn [[]], không đọc nguồn function nào", () => {
    const base = withFunctions(100)
    const spine = { ...base, functions: base.functions.map((f) => withBusinessValidation(f, f.id)) }
    expect(functionBatches(spine, "S-7.2")).toEqual([[]])
    expect(functionBatches(spine, "S-7.4")).toEqual([[]])
  })
})
