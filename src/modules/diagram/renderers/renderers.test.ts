import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine, UseCase } from "../../spine/spine.types.js"
import { VIETNAMESE_DIACRITICS } from "../../spine/deterministic-check.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { allTargets, layoutOwners, renderKind } from "./index.js"
import { MAX_USE_CASES_PER_DIAGRAM, partitionUseCases } from "./usecase.renderer.js"
import { saltCell } from "./screen-layout.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const only = (spine: Spine, kind: Parameters<typeof renderKind>[1], owner: string | null = null) => {
  const parts = renderKind(spine, kind, owner)
  expect(parts).toHaveLength(1)
  return parts[0]
}

describe("renderers trên fixture 19 màn", () => {
  it("4 hình cố định + wireframe cho 5 màn signed_off", () => {
    expect(layoutOwners(FIXTURE)).toEqual(["S01", "S05", "S07", "S09", "S10"])
    expect(allTargets(FIXTURE)).toHaveLength(9)
  })

  it("mọi hình: mở/đóng đúng, không dấu tiếng Việt, ổn định giữa hai lần gọi (snapshot)", () => {
    for (const target of allTargets(FIXTURE)) {
      for (const part of renderKind(FIXTURE, target.kind, target.owner_id)) {
        const [open, close] = part.kind === "screen_layout" ? ["@startsalt", "@endsalt"] : ["@startuml", "@enduml"]
        expect(part.puml.startsWith(`${open}\n`), part.kind).toBe(true)
        expect(part.puml.endsWith(`${close}\n`), part.kind).toBe(true)
        expect(VIETNAMESE_DIACRITICS.test(part.puml), part.kind).toBe(false)
        expect(renderKind(FIXTURE, target.kind, target.owner_id)[0].puml).toBe(part.puml)
        expect(part.puml).toMatchSnapshot(`${part.kind}${part.owner_id ? `@${part.owner_id}` : ""}`)
      }
    }
  })

  it("context: chỉ actor không phải human, alias theo id", () => {
    const { puml, section } = only(FIXTURE, "context")
    expect(section).toBe("fixed:1")
    for (const a of FIXTURE.actors) expect(puml.includes(` as ${a.id}`), a.id).toBe(a.kind !== "human")
  })

  it("usecase: mọi use case và cạnh include/extend", () => {
    const { puml } = only(FIXTURE, "usecase")
    for (const uc of FIXTURE.use_cases) expect(puml).toContain(`usecase "${uc.name}" as ${uc.id}`)
    for (const uc of FIXTURE.use_cases) for (const inc of uc.includes) expect(puml).toContain(`${uc.id} ..> ${inc} : <<include>>`)
    for (const uc of FIXTURE.use_cases) for (const base of uc.extends) expect(puml).toContain(`${uc.id} ..> ${base} : <<extend>>`)
  })

  it("screen_flow: composite cho màn có tab, note cho pop-up, cạnh flow_to", () => {
    const { puml } = only(FIXTURE, "screen_flow")
    const tabbed = FIXTURE.screens.find((s) => s.tabs.length > 0)!
    expect(puml).toContain(`as ${tabbed.id} {`)
    expect(puml).toContain(`as ${tabbed.id}_T1`)
    for (const popup of FIXTURE.screens.filter((s) => s.is_popup)) expect(puml).toContain(`note right of ${popup.id} : pop-up`)
    expect(puml).toContain("S07 --> S08")
  })

  it("erd: entity và quan hệ crow's foot mặc định", () => {
    const { puml } = only(FIXTURE, "erd")
    expect(puml).toContain('entity "User" as E01')
    expect(puml).toContain("E01 ||--o{ E02")
  })

  it("screen_layout: salt gắn function:<primary>, chỉ màn có primary function", () => {
    const part = only(FIXTURE, "screen_layout", "S07")
    expect(part).toMatchObject({ section: "function:FN028", owner_kind: "screen", owner_id: "S07" })
    for (const f of FIXTURE.functions.filter((x) => x.screen_id === "S07")) expect(part.puml).toContain(saltCell(f.name))
    expect(renderKind(mutate((s) => (s.screens.find((x) => x.id === "S07")!.primary_function_id = null)), "screen_layout", "S07")).toEqual([])
    expect(renderKind(FIXTURE, "screen_layout", "S99")).toEqual([])
    expect(saltCell('a | b {c} "d" [e]')).toBe("a b c d e")
    // `^` mở ô tiêu đề, `()` mở widget radio/checkbox trong Salt
    expect(saltCell("Login (OAuth)^")).toBe("Login OAuth")
  })

  it("Spine rỗng vẫn sinh hình hợp lệ về cú pháp", () => {
    const empty = createEmptySpine({ name: "Empty" })
    expect(only(empty, "screen_flow").puml).toContain("NO_SCREENS")
    expect(only(empty, "erd").puml).toContain("NO_ENTITIES")
    expect(only(empty, "context").puml).toContain('rectangle "Empty" as SYSTEM_')
  })
})

describe("usecase > 25 ⇒ tách theo nhóm actor", () => {
  const manyUseCases = (n: number): Spine =>
    mutate((s) => {
      const actorIds = s.actors.filter((a) => a.kind === "human").map((a) => a.id)
      s.use_cases = Array.from({ length: n }, (_, i): UseCase => ({
        id: `UC${String(i + 1).padStart(3, "0")}`,
        name: `Use Case ${i + 1}`,
        actor_ids: [actorIds[i % actorIds.length]],
        function_ids: [],
        description: "",
        includes: i > 0 ? [`UC${String(i).padStart(3, "0")}`] : [],
        extends: []
      }))
    })

  it("mỗi phần ≤ 25, đủ mọi use case, không trùng", () => {
    const spine = manyUseCases(60)
    const parts = partitionUseCases(spine.use_cases)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    expect(parts.flat().map((u) => u.id).sort()).toEqual(spine.use_cases.map((u) => u.id).sort())

    const rendered = renderKind(spine, "usecase")
    expect(rendered).toHaveLength(parts.length)
    expect(rendered[0].puml).toContain(`title Use Cases (part 1 of ${parts.length})`)
    expect(new Set(rendered.map((r) => r.source_hash)).size).toBe(1)
  })

  it("≤ 25 use case giữ một hình", () => {
    expect(renderKind(manyUseCases(25), "usecase")).toHaveLength(1)
  })
})

describe("source_hash (DoD T10)", () => {
  it("đổi actors[].description không đổi hash usecase; đổi name thì đổi", () => {
    const base = only(FIXTURE, "usecase").source_hash
    expect(only(mutate((s) => (s.actors[0].description = "Changed")), "usecase").source_hash).toBe(base)
    expect(only(mutate((s) => (s.actors[0].name = "Changed")), "usecase").source_hash).not.toBe(base)
  })
})
