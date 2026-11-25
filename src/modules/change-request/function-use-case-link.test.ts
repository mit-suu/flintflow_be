import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { concreteBatch, distributeOps } from "./add-use-case.service.js"
import { linkFunctionsToUseCases } from "./function-use-case-link.js"

/** FLF-469 (A3): lưới an toàn của luật 3i / 3j - chức năng mới gắn use case đoán được, use case hết chức năng bị xoá. */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withFunction = (spine: Spine, screenId: string | null, featureId: string): Spine => {
  const clone = structuredClone(spine)
  clone.functions.push({ ...clone.functions[0], id: "FN900", name: "Change Delivery Address", screen_id: screenId, feature_id: featureId })
  return clone
}

describe("linkFunctionsToUseCases - thêm chức năng", () => {
  it("use case duy nhất có chức năng cùng màn ⇒ op set function_ids = danh sách cũ + chức năng mới, kèm ghi chú", () => {
    const after = withFunction(FIXTURE, "S01", "F1")
    const fix = linkFunctionsToUseCases(FIXTURE, after, "add")
    const uc = FIXTURE.use_cases.find((u) => u.id === "UC02")!
    expect(fix.ops).toEqual([expect.objectContaining({ op: "set", path: "use_cases[id=UC02].function_ids", value: [...uc.function_ids, "FN900"] })])
    expect(fix.notes).toEqual([expect.stringContaining("Gắn chức năng \"Change Delivery Address\" vào use case")])
  })

  it("hai use case cùng có chức năng trên màn ⇒ không op, ghi chú 'chưa gắn'", () => {
    const fix = linkFunctionsToUseCases(FIXTURE, withFunction(FIXTURE, "S05", "F2"), "add")
    expect(fix.ops).toEqual([])
    expect(fix.notes).toEqual([expect.stringContaining("chưa gắn use case nào")])
  })

  it("màn chưa có use case nào, cùng tính năng với đúng một use case ⇒ chọn use case đó", () => {
    const only = structuredClone(FIXTURE)
    only.use_cases = only.use_cases.filter((u) => u.id === "UC20")
    const fix = linkFunctionsToUseCases(only, withFunction(only, "S18", "F6"), "add")
    expect(fix.ops.map((o) => o.path)).toEqual(["use_cases[id=UC20].function_ids"])
  })

  it("model đã gắn rồi ⇒ không op, không ghi chú", () => {
    const after = withFunction(FIXTURE, "S01", "F1")
    after.use_cases.find((u) => u.id === "UC02")!.function_ids.push("FN900")
    expect(linkFunctionsToUseCases(FIXTURE, after, "add")).toEqual({ ops: [], notes: [] })
  })

  it("lô thật (id thật) + op gắn của code áp được, chia về vị trí use case có sẵn, không tạo use case mới", () => {
    const first = concreteBatch(FIXTURE, [
      { op: "add", path: "functions[]", value: { name: "Change Delivery Address", screen_id: "S01", feature_id: "F1", order: 99, trigger: "Click Change", description: "Changes the address.", normal: ["a"], abnormal: ["b"], validations: [] } }
    ])!
    const fix = linkFunctionsToUseCases(FIXTURE, first.after, "add")
    expect(fix.ops).toHaveLength(1)
    const batch = concreteBatch(FIXTURE, [...first.ops, ...fix.ops])
    expect(batch).not.toBeNull()
    const paths = distributeOps(FIXTURE, batch!.after, batch!.ops).map((x) => x.path)
    expect(paths).toEqual(expect.arrayContaining(["functions[]", "use_cases[id=UC02]"]))
    expect(batch!.after.use_cases).toHaveLength(FIXTURE.use_cases.length)
  })
})

describe("linkFunctionsToUseCases - xoá chức năng", () => {
  const without = (spine: Spine, ...ids: string[]): Spine => {
    const clone = structuredClone(spine)
    clone.functions = clone.functions.filter((f) => !ids.includes(f.id))
    for (const u of clone.use_cases) u.function_ids = u.function_ids.filter((id) => !ids.includes(id))
    return clone
  }

  it("xoá chức năng duy nhất của use case ⇒ op remove use case", () => {
    const fix = linkFunctionsToUseCases(FIXTURE, without(FIXTURE, "FN022"), "remove")
    expect(fix.ops).toEqual([expect.objectContaining({ op: "remove", path: "use_cases[id=UC24]" })])
    expect(fix.notes).toEqual([expect.stringContaining("không còn chức năng nào")])
  })

  it("use case còn chức năng khác ⇒ không op", () => {
    expect(linkFunctionsToUseCases(FIXTURE, without(FIXTURE, "FN018"), "remove")).toEqual({ ops: [], notes: [] })
  })
})
