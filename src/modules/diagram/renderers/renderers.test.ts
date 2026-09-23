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
import { screenFlowTitleOf } from "./screen-flow.renderer.js"

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
      const parts = renderKind(FIXTURE, target.kind, target.owner_id)
      for (const [i, part] of parts.entries()) {
        const [open, close] =
          part.kind === "screen_layout" ? ["@startsalt", "@endsalt"] : part.kind === "screen_flow" ? ["@startdot", "@enddot"] : ["@startuml", "@enduml"]
        expect(part.puml.startsWith(`${open}\n`), part.kind).toBe(true)
        expect(part.puml.endsWith(`${close}\n`), part.kind).toBe(true)
        expect(VIETNAMESE_DIACRITICS.test(part.puml), part.kind).toBe(false)
        expect(renderKind(FIXTURE, target.kind, target.owner_id)[i].puml).toBe(part.puml)
        const name = `${part.kind}${part.owner_id ? `@${part.owner_id}` : ""}`
        expect(part.puml).toMatchSnapshot(parts.length > 1 ? `${name}#${i + 1}` : name)
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

  it("screen_flow: DOT — màn nhiều tab là cluster, popup viền đứt, cạnh flow_to", () => {
    const puml = renderKind(FIXTURE, "screen_flow").map((p) => p.puml).join("\n")
    const tabbed = FIXTURE.screens.find((s) => s.tabs.length > 0)!
    expect(puml).toContain(`subgraph cluster_${tabbed.id} {`)
    expect(puml).toContain(`${tabbed.id}_T1 [label="${tabbed.tabs[0]}"];`)
    for (const popup of FIXTURE.screens.filter((s) => s.is_popup)) {
      expect(puml).toContain(`${popup.id} [label="${popup.name}\\n(pop-up)", style="rounded,dashed"];`)
    }
    // Cạnh đi từ màn nhiều tab gắn vào cluster
    expect(puml).toContain("S07_T1 -> S08 [ltail=cluster_S07];")
  })

  it("screen_flow: một sơ đồ cho mỗi actor người, bắt đầu bằng hình thoi mang tên actor", () => {
    const parts = renderKind(FIXTURE, "screen_flow")
    expect(parts.map((p) => screenFlowTitleOf(p.puml))).toEqual([
      "Screens flow for Founder",
      "Screens flow for Business Analyst",
      "Screens flow for Administrator",
      "Screens flow for Guest"
    ])
    expect(parts.every((p) => p.owner_id === null && p.section === "fixed:3.1.1")).toBe(true)
    expect(parts.every((p) => p.puml.startsWith("@startdot\n") && p.puml.endsWith("@enddot\n"))).toBe(true)

    const admin = parts[2].puml
    expect(admin).toContain('START [label="Administrator", shape=diamond, style=solid];')
    expect(admin).toContain("START -> S01;")
    expect(admin).toContain("S14 -> S16;")
    // Màn của actor khác và cạnh sang màn ngoài nhóm không vẽ
    expect(admin).not.toContain("cluster_S07")
    expect(admin).not.toContain("S01 -> S05;")

    const guest = parts[3].puml
    expect(guest).toContain('START [label="Guest", shape=diamond, style=solid];')
    expect(guest).toContain("START -> S01;")
    expect(guest).toContain("S01 -> S02;")
  })

  it("screen_flow: mũi tên một chiều — cặp màn trỏ qua lại chỉ giữ chiều đi tiếp từ màn vào", () => {
    const [founder, , admin, guest] = renderKind(FIXTURE, "screen_flow").map((p) => p.puml)
    // Login ⇄ Register: chỉ Login → Register
    expect(guest).toContain("S01 -> S02;")
    expect(guest).not.toContain("S02 -> S01;")
    // Workspace ⇄ Diagram Preview: chỉ Workspace → Preview
    expect(founder).toContain("S07_T1 -> S08 [ltail=cluster_S07];")
    expect(founder).not.toContain("S08 -> S07_T1")
    expect(admin).toContain("S14 -> S15;")
    expect(admin).not.toContain("S15 -> S14;")
    for (const p of [founder, admin, guest]) {
      const edges = new Set([...p.matchAll(/^ {2}(\w+) -> (\w+)/gm)].map((m) => `${m[1]}>${m[2]}`))
      for (const e of edges) expect(edges.has(e.split(">").reverse().join(">")), e).toBe(false)
    }
  })

  it("screen_flow: màn không actor nào dùng ⇒ sơ đồ Unassigned cuối (chấm đen); chưa có liên kết actor ⇒ một sơ đồ chung", () => {
    const withOrphan = mutate((s) => {
      s.screens.push({ ...s.screens.find((x) => x.id === "S13")!, id: "S20", name: "Orphan Screen", flow_to: [] })
    })
    const parts = renderKind(withOrphan, "screen_flow")
    const last = parts[parts.length - 1].puml
    expect(screenFlowTitleOf(last)).toBe("Screens flow for unassigned screens")
    expect(last).toContain('S20 [label="Orphan Screen"];')
    expect(last).toContain("START [label=\"\", shape=circle")

    const unlinked = mutate((s) => {
      s.permissions = []
      s.use_cases = s.use_cases.map((u) => ({ ...u, function_ids: [] }))
    })
    const [single, ...rest] = renderKind(unlinked, "screen_flow")
    expect(rest).toEqual([])
    expect(screenFlowTitleOf(single.puml)).toBeNull()
    expect(single.puml).toContain("START [label=\"\", shape=circle")
    expect(single.puml).toContain("START -> S01;")
  })

  it("screen_flow: nhãn DOT escape dấu ngoặc kép và gạch chéo", () => {
    const tricky = mutate((s) => {
      s.screens.find((x) => x.id === "S01")!.name = 'Log "in" \\ out'
    })
    // Tên có một `\` ⇒ DOT nhận `\\`; `"` đổi thành `'`
    expect(renderKind(tricky, "screen_flow")[3].puml).toContain("S01 [label=\"Log 'in' \\\\ out\"];")
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
