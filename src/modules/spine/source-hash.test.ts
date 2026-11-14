import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { DIAGRAM_ENGINES, computeSourceHash, renderedDiagramHash } from "./source-hash.js"
import { originalDiagramHash } from "./original-diagram.js"
import { sharedScreenIds } from "./screen-actors.js"

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
    // Tên hệ thống đi qua `systemName()`: fixture đã đặt `system_name` nên đổi `project.name` không đổi hash
    expect(computeSourceHash(mutate((s) => (s.project.name = "X")), context)).toBe(base)
    expect(computeSourceHash(mutate((s) => (s.project.system_name = "X")), context)).not.toBe(base)
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

describe("computeSourceHash - tên hệ thống (FLF-177)", () => {
  const usecase = { kind: "usecase" as const, owner_id: null }
  const context = { kind: "context" as const, owner_id: null }

  it("chưa đặt system_name ⇒ hash như trước FLF-177 (hình cũ không bị diagram_stale hàng loạt)", () => {
    const legacy = mutate((s) => (s.project.system_name = null))
    expect(computeSourceHash(legacy, usecase)).toBe(computeSourceHash(mutate((s) => (s.project.system_name = "  ")), usecase))
    // usecase không hash project.name (giữ hành vi cũ), context hash tên đang vẽ
    const renamed = mutate((s) => {
      s.project.system_name = null
      s.project.name = "X"
    })
    expect(computeSourceHash(renamed, usecase)).toBe(computeSourceHash(legacy, usecase))
    expect(computeSourceHash(renamed, context)).not.toBe(computeSourceHash(legacy, context))
  })

  it("đặt/đổi system_name làm hình use case + ngữ cảnh cũ; khi đã đặt, đổi project.name không làm cũ", () => {
    const named = mutate((s) => (s.project.system_name = "ShipFast"))
    for (const d of [usecase, context]) {
      expect(computeSourceHash(named, d)).not.toBe(computeSourceHash(FIXTURE, d))
      expect(computeSourceHash(mutate((s) => (s.project.system_name = "ShipFast Pro")), d)).not.toBe(computeSourceHash(named, d))
    }
    const renamed = mutate((s) => {
      s.project.system_name = "ShipFast"
      s.project.name = "Du an giao hang"
    })
    expect(computeSourceHash(renamed, context)).toBe(computeSourceHash(named, context))
  })
})

describe("renderedDiagramHash - hash của hình đã vẽ theo engine (FLF-339)", () => {
  const targets = [
    { kind: "context" as const, owner_id: null },
    { kind: "usecase" as const, owner_id: null },
    { kind: "screen_flow" as const, owner_id: null },
    { kind: "erd" as const, owner_id: null },
    { kind: "screen_layout" as const, owner_id: FIXTURE.screens[0].id }
  ]

  it("engine mặc định ⇒ đúng computeSourceHash: hình PlantUML đang có không stale khi deploy", () => {
    const legacy = Object.fromEntries(Object.keys(DIAGRAM_ENGINES).map((k) => [k, "plantuml@1"])) as typeof DIAGRAM_ENGINES
    for (const d of targets) expect(renderedDiagramHash(FIXTURE, d, legacy)).toBe(computeSourceHash(FIXTURE, d))
  })

  it("đổi engine của một kind ⇒ hash hình của kind đó đổi; hash dữ liệu (ảnh gốc import) không đổi", () => {
    const svgContext = { ...DIAGRAM_ENGINES, context: "svg@1" }
    const context = targets[0]
    expect(renderedDiagramHash(FIXTURE, context, svgContext)).not.toBe(renderedDiagramHash(FIXTURE, context))
    // kind không đổi engine ⇒ hash giữ nguyên
    const deployment = { kind: "deployment" as const, owner_id: null }
    expect(renderedDiagramHash(FIXTURE, deployment, svgContext)).toBe(computeSourceHash(FIXTURE, deployment))
    expect(originalDiagramHash(FIXTURE, "context")).toBe(computeSourceHash(FIXTURE, context))
    // vẫn theo dữ liệu: sửa tên actor làm hình svg cũ
    const renamed = mutate((s) => (s.actors[0].name = "Renamed"))
    expect(renderedDiagramHash(renamed, context, svgContext)).not.toBe(renderedDiagramHash(FIXTURE, context, svgContext))
  })

  it("screen_layout (FLF-410): theme đã resolve nằm trong hash hình; dữ liệu ảnh gốc không đổi theo theme", () => {
    const layout = targets[4]
    const base = renderedDiagramHash(FIXTURE, layout)
    // engine svg ⇒ wireframe Salt cũ (hash plantuml) thành stale
    expect(base).not.toBe(computeSourceHash(FIXTURE, layout))
    // theme thiếu = theme mặc định đã resolve
    expect(renderedDiagramHash(FIXTURE, layout, undefined, { screenTheme: { primaryColor: null, domain: null, platforms: null } })).toBe(base)
    expect(renderedDiagramHash(FIXTURE, layout, undefined, { screenTheme: { primaryColor: "#3F5591", domain: null, platforms: ["web"] } })).toBe(base)
    for (const screenTheme of [
      { primaryColor: "#E4572E", domain: null, platforms: null },
      { primaryColor: null, domain: "shop.vn", platforms: null },
      { primaryColor: null, domain: null, platforms: ["web", "mobile"] as ("web" | "mobile")[] }
    ])
      expect(renderedDiagramHash(FIXTURE, layout, undefined, { screenTheme })).not.toBe(base)
    // ký pháp ERD không ảnh hưởng hình màn
    expect(renderedDiagramHash(FIXTURE, layout, undefined, { erdNotation: "idef1x" })).toBe(base)
  })

  it("ERD: ký pháp của dự án (ngoài Spine) nằm trong hash hình - đổi ký pháp ⇒ hình cũ, thiếu ký pháp = chen", () => {
    const erd = targets[3]
    const chen = renderedDiagramHash(FIXTURE, erd, undefined, { erdNotation: "chen" })
    expect(renderedDiagramHash(FIXTURE, erd)).toBe(chen)
    expect(renderedDiagramHash(FIXTURE, erd, undefined, {})).toBe(chen)
    expect(renderedDiagramHash(FIXTURE, erd, undefined, { erdNotation: "crowsfoot" })).not.toBe(chen)
    expect(renderedDiagramHash(FIXTURE, erd, undefined, { erdNotation: "idef1x" })).not.toBe(renderedDiagramHash(FIXTURE, erd, undefined, { erdNotation: "crowsfoot" }))
    // kind khác không phụ thuộc ký pháp ERD
    expect(renderedDiagramHash(FIXTURE, targets[0], undefined, { erdNotation: "idef1x" })).toBe(renderedDiagramHash(FIXTURE, targets[0]))
    // dữ liệu ảnh gốc import không đổi
    expect(computeSourceHash(FIXTURE, erd)).toBe(computeSourceHash(FIXTURE, erd))
  })

  it("luồng màn: đổi feature / thứ tự feature (dùng khi tách hình) hay actor của màn làm hình cũ; mô tả màn, tên feature thì không", () => {
    const flow = targets[2]
    const base = renderedDiagramHash(FIXTURE, flow)
    expect(base).not.toBe(computeSourceHash(FIXTURE, flow))
    expect(renderedDiagramHash(mutate((s) => (s.screens[0].description = "X")), flow)).toBe(base)
    expect(renderedDiagramHash(mutate((s) => (s.screens[0].feature_id = "F2")), flow)).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (s.features[0].name = "Renamed")), flow)).toBe(base)
    expect(renderedDiagramHash(mutate((s) => (s.features[1].order = 99)), flow)).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (s.use_cases.find((u) => u.id === "UC04")!.actor_ids = ["A02"])), flow)).not.toBe(base)
    expect(renderedDiagramHash(mutate((s) => (s.actors.find((a) => a.id === "A01")!.name = "Renamed")), flow)).not.toBe(base)
  })
})

describe("renderedDiagramHash - usecase", () => {
  it("bộ xếp thử nhiều phương án (svg@2) làm hình use case svg@1 cũ thành stale", () => {
    const usecase = { kind: "usecase" as const, owner_id: null }
    expect(DIAGRAM_ENGINES.context).toBe("svg@2")
    expect(DIAGRAM_ENGINES.usecase).toBe("svg@3")
    expect(renderedDiagramHash(FIXTURE, usecase)).not.toBe(renderedDiagramHash(FIXTURE, usecase, { ...DIAGRAM_ENGINES, usecase: "svg@1" }))
  })

  it("FLF-421: phân cấp actor nối kiểu cây (svg@3) làm hình use case svg@2 cũ thành stale", () => {
    const usecase = { kind: "usecase" as const, owner_id: null }
    expect(renderedDiagramHash(FIXTURE, usecase)).not.toBe(renderedDiagramHash(FIXTURE, usecase, { ...DIAGRAM_ENGINES, usecase: "svg@2" }))
  })
})

describe("renderedDiagramHash - screen_flow theo template FPT", () => {
  const flow = { kind: "screen_flow" as const, owner_id: null }

  it("bố cục mới (svg@3: chỉ vẽ cây, tách theo actor) làm hình svg@2 cũ thành stale", () => {
    expect(DIAGRAM_ENGINES.screen_flow).toBe("svg@3")
    expect(renderedDiagramHash(FIXTURE, flow)).not.toBe(renderedDiagramHash(FIXTURE, flow, { ...DIAGRAM_ENGINES, screen_flow: "svg@2" }))
  })

  it("đổi tập màn dùng chung (nền xanh) đổi hash hình, không đổi hash dữ liệu ảnh gốc", () => {
    // Thêm mọi actor người vào cuối actor_ids của một use case: actor đại diện của màn (actor đầu tiên, fixture không có
    // actor tổng quát) giữ nguyên ⇒ dữ liệu nguồn không đổi, nhưng màn của use case đó thành màn dùng chung
    const humans = FIXTURE.actors.filter((a) => a.kind === "human").map((a) => a.id)
    const shared = sharedScreenIds(FIXTURE)
    const uc = FIXTURE.use_cases.find((u) => FIXTURE.screens.some((x) => !shared.has(x.id) && u.function_ids.includes(x.primary_function_id ?? "")))!
    const widened = mutate((s) => {
      const target = s.use_cases.find((u) => u.id === uc.id)!
      target.actor_ids = [...target.actor_ids, ...humans.filter((h) => !target.actor_ids.includes(h))]
    })
    expect(sharedScreenIds(widened)).not.toEqual(shared)
    expect(computeSourceHash(widened, flow)).toBe(computeSourceHash(FIXTURE, flow))
    expect(renderedDiagramHash(widened, flow)).not.toBe(renderedDiagramHash(FIXTURE, flow))
  })
})

describe("renderedDiagramHash - sequence theo mức của dự án (FLF-418)", () => {
  const target = { kind: "sequence" as const, owner_id: "FN001" }
  const withComponent = mutate((s) => {
    s.functions.find((f) => f.id === "FN001")!.component_interactions = [
      { from: "A01", to: "S01", message: "Submit email and password", kind: "request", flow: "normal" },
      { from: "S01", to: "control", message: "Authenticate credentials", kind: "request", flow: "normal" }
    ]
  })

  it("engine plantuml@2: hình plantuml@1 cũ stale một lượt; thiếu mức = system", () => {
    expect(DIAGRAM_ENGINES.sequence).toBe("plantuml@2")
    expect(renderedDiagramHash(FIXTURE, target)).not.toBe(computeSourceHash(FIXTURE, target))
    expect(renderedDiagramHash(FIXTURE, target, DIAGRAM_ENGINES, {})).toBe(renderedDiagramHash(FIXTURE, target, DIAGRAM_ENGINES, { sequenceLevel: "system" }))
  })

  it("đổi mức ⇒ hash đổi; mức system không phụ thuộc component_interactions; mức component theo dữ liệu thành phần + tên feature", () => {
    const system = { sequenceLevel: "system" as const }
    const component = { sequenceLevel: "component" as const }
    expect(renderedDiagramHash(withComponent, target, DIAGRAM_ENGINES, component)).not.toBe(renderedDiagramHash(withComponent, target, DIAGRAM_ENGINES, system))
    expect(renderedDiagramHash(withComponent, target, DIAGRAM_ENGINES, system)).toBe(renderedDiagramHash(FIXTURE, target, DIAGRAM_ENGINES, system))
    const renamedFeature = structuredClone(withComponent)
    renamedFeature.features.find((f) => f.id === "F1")!.name = "Sign In"
    expect(renderedDiagramHash(renamedFeature, target, DIAGRAM_ENGINES, component)).not.toBe(renderedDiagramHash(withComponent, target, DIAGRAM_ENGINES, component))
  })

  it("hash dữ liệu (ảnh gốc import) không đổi theo mức", () => {
    expect(computeSourceHash(withComponent, target)).toBe(computeSourceHash(FIXTURE, target))
  })
})
