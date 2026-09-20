import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { computeSourceHash } from "./source-hash.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}

describe("computeSourceHash", () => {
  it("ổn định: cùng dữ liệu cùng hash, không phụ thuộc thứ tự phần tử", () => {
    for (const d of FIXTURE.diagrams) {
      expect(computeSourceHash(FIXTURE, d)).toMatch(/^[0-9a-f]{64}$/)
      expect(computeSourceHash(structuredClone(FIXTURE), d)).toBe(computeSourceHash(FIXTURE, d))
    }
    const reversed = mutate((s) => s.actors.reverse())
    expect(computeSourceHash(reversed, { kind: "usecase", owner_id: null })).toBe(computeSourceHash(FIXTURE, { kind: "usecase", owner_id: null }))
  })

  it("usecase: đổi tên actor đổi hash, đổi mô tả actor thì không", () => {
    const base = computeSourceHash(FIXTURE, { kind: "usecase", owner_id: null })
    expect(computeSourceHash(mutate((s) => (s.actors[0].name = "X")), { kind: "usecase", owner_id: null })).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.actors[0].description = "X")), { kind: "usecase", owner_id: null })).toBe(base)
  })

  it("context xét mọi actor và tên/actor_ids của use case (nhãn cạnh), không xét mô tả", () => {
    const context = { kind: "context" as const, owner_id: null }
    const human = FIXTURE.actors.findIndex((a) => a.kind === "human")
    const base = computeSourceHash(FIXTURE, context)
    expect(computeSourceHash(mutate((s) => (s.actors[human].name = "X")), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.project.name = "X")), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.use_cases[0].name = "X")), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.use_cases[0].actor_ids = [])), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.actors[0].flows_in = ["X"])), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.actors[0].flows_out = ["X"])), context)).not.toBe(base)
    expect(computeSourceHash(mutate((s) => (s.use_cases[0].description = "X")), context)).toBe(base)
    expect(computeSourceHash(mutate((s) => (s.actors[human].description = "X")), context)).toBe(base)
  })

  it("screen_layout theo màn sở hữu; screen_flow, erd theo field vẽ", () => {
    const layout = { kind: "screen_layout" as const, owner_id: "S07" }
    const fnOfS07 = FIXTURE.functions.findIndex((f) => f.screen_id === "S07")
    const fnOther = FIXTURE.functions.findIndex((f) => f.screen_id === "S01")
    expect(computeSourceHash(mutate((s) => (s.functions[fnOfS07].description = "X")), layout)).not.toBe(computeSourceHash(FIXTURE, layout))
    expect(computeSourceHash(mutate((s) => (s.functions[fnOther].description = "X")), layout)).toBe(computeSourceHash(FIXTURE, layout))

    const flow = { kind: "screen_flow" as const, owner_id: null }
    expect(computeSourceHash(mutate((s) => (s.screens[0].description = "X")), flow)).toBe(computeSourceHash(FIXTURE, flow))
    expect(computeSourceHash(mutate((s) => (s.screens[0].is_popup = !s.screens[0].is_popup)), flow)).not.toBe(computeSourceHash(FIXTURE, flow))

    const erd = { kind: "erd" as const, owner_id: null }
    expect(computeSourceHash(mutate((s) => (s.entities[0].relations = [])), erd)).not.toBe(computeSourceHash(FIXTURE, erd))
  })
})
