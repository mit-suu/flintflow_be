import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine, UseCase } from "../../spine/spine.types.js"
import { VIETNAMESE_DIACRITICS } from "../../spine/deterministic-check.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { allTargets, layoutOwners, renderKind } from "./index.js"
import { MAX_ASSOCIATIONS_PER_DIAGRAM, MAX_CLUSTER_SPAN, MAX_USE_CASES_PER_DIAGRAM, actorUseCaseCounts, dependentUseCaseIds, partitionUseCases } from "./usecase.renderer.js"
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
/** Sơ đồ use case có thể tách nhiều phần — luật cạnh áp trên toàn sơ đồ nên xét chung. */
const usecaseParts = (spine: Spine): string[] => renderKind(spine, "usecase").map((p) => p.puml)
const usecasePuml = (spine: Spine): string => usecaseParts(spine).join("\n")
const declaredActors = (puml: string): string[] => [...puml.matchAll(/^actor "[^"]*" as (\w+)/gm)].map((m) => m[1])

describe("renderers trên fixture 19 màn", () => {
  it("4 hình cố định + wireframe cho 5 màn signed_off", () => {
    expect(layoutOwners(FIXTURE)).toEqual(["S01", "S05", "S07", "S09", "S10"])
    expect(allTargets(FIXTURE)).toHaveLength(9)
  })

  it("mọi hình: mở/đóng đúng, không dấu tiếng Việt, ổn định giữa hai lần gọi (snapshot)", () => {
    for (const target of allTargets(FIXTURE)) {
      const rendered = renderKind(FIXTURE, target.kind, target.owner_id)
      for (const [index, part] of rendered.entries()) {
        const [open, close] =
          part.kind === "screen_layout" ? ["@startsalt", "@endsalt"] : part.kind === "screen_flow" ? ["@startdot", "@enddot"] : ["@startuml", "@enduml"]
        expect(part.puml.startsWith(`${open}\n`), part.kind).toBe(true)
        expect(part.puml.endsWith(`${close}\n`), part.kind).toBe(true)
        expect(VIETNAMESE_DIACRITICS.test(part.puml), part.kind).toBe(false)
        expect(renderKind(FIXTURE, target.kind, target.owner_id)[index].puml).toBe(part.puml)
        const owner = part.owner_id ? `@${part.owner_id}` : ""
        expect(part.puml).toMatchSnapshot(`${part.kind}${owner}${rendered.length > 1 ? ` part ${index + 1}` : ""}`)
      }
    }
  })

  it("context: hệ thống là vòng tròn, actor xếp vòng quanh, mỗi actor đúng MỘT cạnh", () => {
    const { puml, section } = only(FIXTURE, "context")
    expect(section).toBe("fixed:1")
    expect(puml).toContain('usecase "\\n\\n   FlintFlow   \\n\\n" as SYSTEM_')
    expect(puml).not.toContain("skinparam linetype")
    expect(puml).not.toContain("[hidden]")
    const lines = puml.split(String.fromCharCode(10))
    // Vòng quanh theo thứ tự id: actor đầu bên trái, actor thứ hai bên phải, còn lại xen kẽ trên/dưới
    const SIDES = ["left", "right", "top", "bottom"] as const
    const sideOf = (i: number) => (i === 0 ? SIDES[0] : i === 1 ? SIDES[1] : i % 2 === 0 ? SIDES[2] : SIDES[3])
    const INTO = { left: "right", right: "left", top: "down", bottom: "up" } as const
    const sorted = [...FIXTURE.actors].sort((a, b) => (a.id < b.id ? -1 : 1))
    sorted.forEach((a, i) => {
      expect(puml, a.id).toContain(`rectangle "${a.name}" as ${a.id}\n`)
      // Một cạnh duy nhất: hai cạnh riêng làm nhãn dồn về một phía, hình bị lệch
      expect(lines.filter((l) => l.includes(a.id) && l.includes("->")).length, a.id).toBe(1)
      if (a.flows_in?.length && a.flows_out?.length) expect(puml, a.id).toContain(`${a.id} <-${INTO[sideOf(i)]}-> SYSTEM_ : `)
    })
  })

  it("context: cặp hai chiều ⇒ mũi tên hai đầu, nhãn hai dòng có ký hiệu chiều khớp vị trí", () => {
    const { puml } = only(FIXTURE, "context")
    // A01 bên trái: actor → hệ thống là "→", chiều ngược là "←"
    expect(puml).toContain("A01 <-right-> SYSTEM_ : → brief answers, accepted step\\n← draft section, srs document\n")
    // A03 hàng trên: actor → hệ thống là "↓"
    expect(puml).toContain("A03 <-down-> SYSTEM_ : ↓ account action\\n↑ platform metrics\n")
    // Một chiều ⇒ mũi tên thường, không có ký hiệu chiều trong nhãn
    expect(puml).toContain("A04 -up-> SYSTEM_ : registration request\n")
    expect(puml).toContain("SYSTEM_ -down-> A08 : email request\n")
  })

  it("context: quá 3 nhãn một chiều ⇒ gộp '+ N more'", () => {
    const many = ["a", "b", "c", "d", "e"]
    const { puml } = only(mutate((s) => (s.actors.find((a) => a.id === "A01")!.flows_in = many)), "context")
    expect(puml).toContain("A01 <-right-> SYSTEM_ : → a, b, c, + 2 more\\n←")
  })

  it("context: không có flows ⇒ cạnh một chiều mang tên use case, chiều suy từ kind", () => {
    const { puml } = only(
      mutate((s) =>
        s.actors.forEach((a) => {
          delete a.flows_in
          delete a.flows_out
        })
      ),
      "context"
    )
    expect(puml).not.toContain("<-")
    expect(puml).toMatch(/SYSTEM_ -\w+-> A05 : Purchase Credits\n/)
    const founderUseCases = FIXTURE.use_cases.filter((uc) => uc.actor_ids.includes("A01")).length
    expect(puml).toMatch(new RegExp(`A01 -\\w+-> SYSTEM_ : [^\\n]*\\\\n\\+ ${founderUseCases - 3} more\\n`))
  })

  it("context: không flows, không use case ⇒ cạnh không nhãn", () => {
    const { puml } = only(
      mutate((s) => {
        s.use_cases = []
        s.actors.forEach((a) => {
          delete a.flows_in
          delete a.flows_out
        })
      }),
      "context"
    )
    expect(puml).toMatch(/A01 -\w+-> SYSTEM_\n/)
    expect(puml).toMatch(/SYSTEM_ -\w+-> A05\n/)
  })

  it("usecase: mọi use case và cạnh include/extend", () => {
    const puml = usecasePuml(FIXTURE)
    for (const uc of FIXTURE.use_cases) expect(puml).toContain(`usecase "${uc.name}" as ${uc.id}`)
    for (const uc of FIXTURE.use_cases) for (const inc of uc.includes) expect(puml).toContain(`${uc.id} ..> ${inc} : <<include>>`)
    for (const uc of FIXTURE.use_cases) for (const base of uc.extends) expect(puml).toContain(`${uc.id} ..> ${base} : <<extend>>`)
  })

  it("usecase: cạnh actor là association, use case mở rộng/bị include không nối actor người", () => {
    const puml = usecasePuml(FIXTURE)
    expect(puml).not.toMatch(/^A\d+ -->/m)

    const human = new Set(FIXTURE.actors.filter((a) => a.kind === "human").map((a) => a.id))
    const dependent = dependentUseCaseIds(FIXTURE.use_cases)
    const counts = actorUseCaseCounts(FIXTURE.use_cases)
    for (const uc of FIXTURE.use_cases.filter((u) => dependent.has(u.id))) {
      for (const actorId of uc.actor_ids.filter((a) => human.has(a) && (counts.get(a) ?? 0) > 1)) {
        expect(puml, `${actorId} -- ${uc.id}`).not.toContain(`${actorId} -- ${uc.id}`)
      }
    }
    expect(puml).toContain("UC12 -- A07") // actor system giữ cạnh ở use case bị include
    // 33 cặp (actor, use case) trong fixture, 6 cặp (đều là actor người) bị luật bỏ cạnh loại
    expect(puml.match(/^\w+ -- \w+$/gm)).toHaveLength(27)
  })

  it("usecase: actor người viết `A -- UC` (trái), actor system/time viết `UC -- A` (phải)", () => {
    const kind = new Map(FIXTURE.actors.map((a) => [a.id, a.kind]))
    for (const puml of usecaseParts(FIXTURE)) {
      for (const [, left, right] of puml.matchAll(/^(\w+) -- (\w+)$/gm)) {
        if (left.startsWith("A")) expect(kind.get(left), `${left} -- ${right}`).toBe("human")
        else expect(kind.get(right), `${left} -- ${right}`).not.toBe("human")
      }
      // actor người khai báo trước `rectangle`, actor system/time sau
      const [before, after] = puml.split(/^rectangle /m)
      for (const id of declaredActors(before)) expect(kind.get(id), id).toBe("human")
      for (const id of declaredActors(after)) expect(kind.get(id), id).not.toBe("human")
    }
  })

  it("usecase: actor tham gia use case luôn được vẽ, kể cả khi mọi cạnh của nó bị bỏ", () => {
    const participating = new Set(FIXTURE.use_cases.flatMap((u) => u.actor_ids))
    expect(participating.size).toBe(9)
    const declared = usecaseParts(FIXTURE).flatMap(declaredActors)
    for (const id of participating) expect(declared, id).toContain(id)

    // A03 (người) chỉ còn tham gia UC20, UC21 và cả hai đều bị UC05 include ⇒ vẫn còn đúng một cạnh
    const spine = mutate((s) => {
      const uc02 = s.use_cases.find((u) => u.id === "UC02")!
      uc02.actor_ids = uc02.actor_ids.filter((a) => a !== "A03")
      s.use_cases.find((u) => u.id === "UC05")!.includes = ["UC20", "UC21"]
    })
    expect(usecasePuml(spine).match(/^A03 -- \w+$/gm)).toEqual(["A03 -- UC20"])
  })

  it("usecase: actor system chỉ tham gia use case mở rộng/bị include vẫn giữ mọi cạnh", () => {
    // A07 tham gia 2 use case và cả hai đều bị UC09 include
    const spine = mutate((s) => (s.use_cases.find((u) => u.id === "UC10")!.actor_ids = ["A07"]))
    expect(usecasePuml(spine).match(/^\w+ -- A07$/gm)).toEqual(["UC10 -- A07", "UC12 -- A07"])
  })

  it("screen_flow: DOT — màn là hình chữ nhật, màn nhiều tab là cluster, popup hình ô-van, cạnh flow_to", () => {
    const puml = renderKind(FIXTURE, "screen_flow").map((p) => p.puml).join("\n")
    const tabbed = FIXTURE.screens.find((s) => s.tabs.length > 0)!
    expect(puml).toContain('node [fontname="DejaVu Sans", fontsize=11, shape=box, color="#000000"];')
    expect(puml).not.toContain("style=rounded")
    expect(puml).toContain(`subgraph cluster_${tabbed.id} {`)
    expect(puml).toContain(`${tabbed.id}_T1 [label="${tabbed.tabs[0]}"];`)
    for (const popup of FIXTURE.screens.filter((s) => s.is_popup)) {
      expect(puml).toContain(`${popup.id} [label="${popup.name}", shape=ellipse];`)
      expect(puml).not.toContain(`${popup.id} [label="${popup.name}\\n(pop-up)"`)
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
    expect(only(empty, "context").puml).toContain('usecase "\\n\\n   Empty   \\n\\n" as SYSTEM_')
    expect(only(empty, "context").puml).not.toContain("-> SYSTEM_")
  })
})

describe("usecase > 20 ⇒ tách theo cụm quan hệ", () => {
  const uc = (n: number, extra: Partial<UseCase> = {}): UseCase => ({
    id: `UC${String(n).padStart(3, "0")}`,
    name: `Use Case ${n}`,
    actor_ids: ["A01"],
    function_ids: [],
    description: "",
    includes: [],
    extends: [],
    ...extra
  })
  /** n use case KHÔNG quan hệ ⇒ phủ đường dồn cụm đơn vào phần. */
  const independentUseCases = (n: number): UseCase[] => Array.from({ length: n }, (_, i) => uc(i + 1))
  /** Cụm 3 phần tử đặt đúng ranh giới dồn ⇒ phủ luật "không cắt giữa cụm". */
  const clusteredUseCases = (): UseCase[] => [
    ...independentUseCases(MAX_USE_CASES_PER_DIAGRAM - 1),
    uc(90, { includes: ["UC091"] }),
    uc(91),
    uc(92, { extends: ["UC091"] })
  ]
  /** Một chuỗi include dài hơn trần cứng ⇒ phủ đường cắt cưỡng bức. */
  const oversizedCluster = (n: number): UseCase[] =>
    Array.from({ length: n }, (_, i) => uc(i + 1, i > 0 ? { includes: [`UC${String(i).padStart(3, "0")}`] } : {}))
  const withUseCases = (useCases: UseCase[]): Spine => mutate((s) => (s.use_cases = useCases))

  it("mỗi phần ≤ 20, đủ mọi use case, không trùng, tiêu đề theo nhóm actor", () => {
    const spine = withUseCases(independentUseCases(45))
    const parts = partitionUseCases(spine.use_cases)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.useCases.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    expect(parts.flatMap((p) => p.useCases).map((u) => u.id).sort()).toEqual(spine.use_cases.map((u) => u.id).sort())

    const rendered = renderKind(spine, "usecase")
    expect(rendered).toHaveLength(parts.length)
    expect(rendered[0].puml).toContain(`title Use Cases — ${spine.actors.find((a) => a.id === "A01")!.name}`)
    expect(new Set(rendered.map((r) => r.source_hash)).size).toBe(1)
  })

  it("tách theo actor người chính: use case của một actor người nằm trọn một hình", () => {
    // Xen kẽ id giữa hai actor người; actor system A05 (id nhỏ hơn không phải lý do để nhóm) đi cùng A01
    const spine = withUseCases(
      Array.from({ length: 24 }, (_, i) => uc(i + 1, { actor_ids: i % 2 === 0 ? ["A01", "A05"] : ["A02"] }))
    )
    const rendered = renderKind(spine, "usecase").map((p) => p.puml)
    expect(rendered.length).toBeGreaterThan(1)
    for (const actorId of ["A01", "A02"]) {
      const holding = rendered.filter((p) => new RegExp(`^${actorId} -- `, "m").test(p))
      expect(holding, actorId).toHaveLength(1)
    }
    const names = (id: string) => spine.actors.find((a) => a.id === id)!.name
    expect(rendered[0]).toContain(`title Use Cases — ${names("A01")}`)
    expect(rendered[1]).toContain(`title Use Cases — ${names("A02")}`)
  })

  it("quá trần số cạnh dù ≤ 20 use case ⇒ tách, mỗi phần ≤ trần cạnh", () => {
    const spine = withUseCases(Array.from({ length: 15 }, (_, i) => uc(i + 1, { actor_ids: ["A01", "A02"] })))
    const rendered = renderKind(spine, "usecase")
    expect(rendered.length).toBeGreaterThan(1)
    for (const { puml } of rendered) {
      expect(puml.match(/^\w+ -- \w+$/gm)!.length).toBeLessThanOrEqual(MAX_ASSOCIATIONS_PER_DIAGRAM)
    }
  })

  it("≤ 20 use case giữ một hình, không có dòng title", () => {
    const rendered = renderKind(withUseCases(independentUseCases(MAX_USE_CASES_PER_DIAGRAM)), "usecase")
    expect(rendered).toHaveLength(1)
    expect(rendered[0].puml).not.toContain("title ")
  })

  it("không cắt giữa cụm quan hệ", () => {
    const cluster = ["UC090", "UC091", "UC092"]
    const holding = partitionUseCases(clusteredUseCases()).filter((p) => p.useCases.some((u) => cluster.includes(u.id)))
    expect(holding).toHaveLength(1)
    expect(holding[0].useCases.map((u) => u.id)).toEqual(cluster)
  })

  it("cụm vượt trần cứng bị cắt: mọi phần ≤ 20, không cạnh trỏ ra ngoài phần", () => {
    const spine = withUseCases(oversizedCluster(MAX_CLUSTER_SPAN + 5))
    expect(partitionUseCases(spine.use_cases).every((p) => p.useCases.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    for (const { puml } of renderKind(spine, "usecase")) {
      const declared = new Set([...puml.matchAll(/usecase "[^"]*" as (\w+)/g)].map((m) => m[1]))
      for (const [, target] of puml.matchAll(/^\w+ \.\.> (\w+) :/gm)) expect(declared).toContain(target)
    }
  })

  it("tên actor có dấu nháy hoặc xuống dòng vẫn cho tiêu đề một dòng", () => {
    const spine = mutate((s) => {
      s.use_cases = independentUseCases(45)
      s.actors.find((a) => a.id === "A01")!.name = 'Founder "Prime"\nAdmin'
    })
    const title = renderKind(spine, "usecase")[0].puml.split("\n").find((l) => l.startsWith("title "))
    expect(title).toBe("title Use Cases — Founder 'Prime' Admin")
  })
})

describe("source_hash (DoD T10)", () => {
  const usecaseHash = (spine: Spine): string => renderKind(spine, "usecase")[0].source_hash

  it("đổi actors[].description không đổi hash usecase; đổi name thì đổi", () => {
    const base = usecaseHash(FIXTURE)
    expect(usecaseHash(mutate((s) => (s.actors[0].description = "Changed")))).toBe(base)
    expect(usecaseHash(mutate((s) => (s.actors[0].name = "Changed")))).not.toBe(base)
  })
})

describe("tên hệ thống (FLF-177)", () => {
  it("boundary use case + sơ đồ ngữ cảnh in `project.system_name`, chưa có ⇒ `project.name`", () => {
    const named = mutate((s) => (s.project.system_name = "ShipFast Delivery"))
    for (const part of usecaseParts(named)) expect(part).toContain('rectangle "ShipFast Delivery" {')
    expect(only(named, "context").puml).toContain('   ShipFast Delivery   ')

    const unnamed = mutate((s) => {
      s.project.system_name = null
      s.project.name = "Du an giao hang"
    })
    expect(usecasePuml(unnamed)).toContain('rectangle "Du an giao hang" {')
    expect(only(unnamed, "context").puml).toContain('   Du an giao hang   ')
  })

  it("system_name rỗng/khoảng trắng coi như chưa đặt", () => {
    const blank = mutate((s) => {
      s.project.system_name = "   "
      s.project.name = "Du an giao hang"
    })
    expect(only(blank, "context").puml).toContain('   Du an giao hang   ')
  })
})
