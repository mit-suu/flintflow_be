import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine, UseCase } from "../../spine/spine.types.js"
import { svgTitleOf } from "./common.js"
import { renderKind, RENDERERS } from "./index.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { ACTOR_HIERARCHY_SECTION, MAX_USE_CASES_PER_DIAGRAM, USE_CASE_SECTION, featureOfUseCase, partitionUseCases, relationChains } from "./usecase.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
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
const withUseCases = (useCases: UseCase[]): Spine => mutate((s) => (s.use_cases = useCases))
const ids = (part: { useCases: UseCase[] }): string[] => part.useCases.map((u) => u.id)
const titles = (spine: Spine): (string | null)[] => renderKind(spine, "usecase").map((p) => svgTitleOf(p.source))

describe("chia hình theo feature", () => {
  it("mỗi feature một hình theo `features[].order`, feature của use case = feature của function đầu trong function_ids", () => {
    const parts = partitionUseCases(FIXTURE)
    expect(parts.map((p) => p.name)).toEqual(FIXTURE.features.filter((f) => FIXTURE.use_cases.some((u) => featureOfUseCase(u, FIXTURE) === f.id)).map((f) => f.name))
    // Log In (UC02) dùng FN001, FN002 của F1; Register Account (UC01) dùng FN006… của F1
    expect(ids(parts[0])).toEqual(expect.arrayContaining(["UC01", "UC02", "UC03", "UC04"]))
    expect(parts.flatMap(ids).sort()).toEqual(FIXTURE.use_cases.map((u) => u.id).sort())
    expect(new Set(parts.flatMap(ids)).size).toBe(FIXTURE.use_cases.length)
  })

  it("nhiều feature ⇒ feature của function đầu tiên; function chết bị bỏ qua; không function ⇒ nhóm theo actor sau các feature", () => {
    const spine = withUseCases([
      uc(1, { function_ids: ["FN028", "FN001"] }), // FN028 thuộc F3, FN001 thuộc F1 ⇒ F3
      uc(2, { function_ids: ["FN-GONE", "FN001"] }), // function chết ⇒ F1
      uc(3, { function_ids: [], actor_ids: ["A02"] })
    ])
    const fn = (id: string) => FIXTURE.functions.find((f) => f.id === id)!.feature_id
    expect(featureOfUseCase(spine.use_cases[0], spine)).toBe(fn("FN028"))
    expect(featureOfUseCase(spine.use_cases[1], spine)).toBe(fn("FN001"))
    expect(featureOfUseCase(spine.use_cases[2], spine)).toBeNull()
    const parts = partitionUseCases(spine)
    expect(parts.map((p) => p.groupKey)).toEqual([fn("FN001"), fn("FN028"), "A02"])
    expect(parts[parts.length - 1].name).toBe(FIXTURE.actors.find((a) => a.id === "A02")!.name)
  })

  it("nhóm > 20 use case ⇒ tách đều trong cùng feature, tiêu đề mang (i/n), đủ use case, không trùng", () => {
    const spine = withUseCases(Array.from({ length: 45 }, (_, i) => uc(i + 1, { function_ids: ["FN001"] })))
    const parts = partitionUseCases(spine)
    expect(parts).toHaveLength(3)
    expect(parts.every((p) => p.useCases.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    expect(parts.map((p) => p.useCases.length)).toEqual([15, 15, 15])
    expect(parts.flatMap(ids).sort()).toEqual(spine.use_cases.map((u) => u.id).sort())
    const feature = FIXTURE.features.find((f) => f.id === FIXTURE.functions.find((x) => x.id === "FN001")!.feature_id)!
    expect(titles(spine)).toEqual([1, 2, 3].map((i) => DIAGRAM_LABELS.en.useCasesTitle(`${feature.name} (${i}/3)`)))
    const rendered = renderKind(spine, "usecase")
    expect(rendered).toHaveLength(3)
    expect(rendered.every((p) => p.section === USE_CASE_SECTION && p.issues?.length === 0 && p.owner_id === null)).toBe(true)
    expect(new Set(rendered.map((r) => r.source_hash)).size).toBe(1)
  })

  it("≤ 20 use case của một feature ⇒ một hình, tiêu đề là tên feature", () => {
    const spine = withUseCases(Array.from({ length: MAX_USE_CASES_PER_DIAGRAM }, (_, i) => uc(i + 1, { function_ids: ["FN001"] })))
    expect(renderKind(spine, "usecase")).toHaveLength(1)
  })

  it("không cắt giữa chuỗi quan hệ khi tách", () => {
    const filler = Array.from({ length: MAX_USE_CASES_PER_DIAGRAM - 1 }, (_, i) => uc(i + 1))
    const chain = [uc(90, { includes: ["UC091"] }), uc(91), uc(92, { extends: ["UC091"] })]
    const holding = partitionUseCases(withUseCases([...filler, ...chain])).filter((p) => p.useCases.some((u) => u.id === "UC090"))
    expect(holding).toHaveLength(1)
    expect(ids(holding[0])).toEqual(expect.arrayContaining(["UC090", "UC091", "UC092"]))
  })

  it("không use case ⇒ không hình; không có parent_id ⇒ không hình phân cấp", () => {
    expect(renderKind(withUseCases([]), "usecase")).toEqual([])
    expect(renderKind(FIXTURE, "usecase").some((p) => p.section === ACTOR_HIERARCHY_SECTION)).toBe(false)
  })
})

describe("bố cục không đạt ⇒ tách hình", () => {
  it("20 use case, 10 actor cùng nối các use case xa nhau ⇒ tách tới khi mọi hình sạch, vẫn đủ use case và cạnh", () => {
    const actors = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"]
    const spine = mutate((s) => {
      s.use_cases = Array.from({ length: 20 }, (_, i) => uc(i + 1, { function_ids: ["FN001"], actor_ids: actors.filter((_, ai) => (i + ai) % 3 === 0) }))
    })
    const rendered = renderKind(spine, "usecase")
    expect(rendered.every((p) => p.issues?.length === 0)).toBe(true)
    const parts = partitionUseCases(spine)
    expect(parts.flatMap(ids).sort()).toEqual(spine.use_cases.map((u) => u.id).sort())
    expect(rendered.length).toBeGreaterThanOrEqual(parts.length)
    const titlesOf = titles(spine)
    expect(new Set(titlesOf).size).toBe(titlesOf.length)
  })
})

describe("include / extend: chuỗi kề nhau", () => {
  it("use case extend hai base nằm giữa hai base; chiều include: base → included, extend: extension → base", () => {
    const spine = withUseCases([uc(1), uc(2, { extends: ["UC001", "UC003"] }), uc(3)])
    const [part] = partitionUseCases(spine)
    expect(ids(part)).toEqual(["UC001", "UC002", "UC003"])
    expect(part.relations).toEqual([
      { from: "UC002", to: "UC001", kind: "extend" },
      { from: "UC002", to: "UC003", kind: "extend" }
    ])
    const include = partitionUseCases(withUseCases([uc(1, { includes: ["UC002"] }), uc(2)]))[0]
    expect(include.relations).toEqual([{ from: "UC001", to: "UC002", kind: "include" }])
  })

  it("use case có > 2 quan hệ ⇒ lặp ở nhiều hình, mỗi quan hệ vẽ đúng một lần và luôn kề nhau", () => {
    const spine = withUseCases([uc(1, { includes: ["UC002", "UC003", "UC004"] }), uc(2), uc(3), uc(4)])
    const parts = partitionUseCases(spine)
    expect(parts.length).toBeGreaterThan(1)
    const drawn = parts.flatMap((p) => p.relations.map((r) => `${r.kind}:${r.from}>${r.to}`)).sort()
    expect(drawn).toEqual(["include:UC001>UC002", "include:UC001>UC003", "include:UC001>UC004"])
    for (const part of parts) {
      const order = new Map(ids(part).map((id, i) => [id, i]))
      expect(new Set(ids(part)).size).toBe(ids(part).length)
      for (const r of part.relations) expect(Math.abs(order.get(r.from)! - order.get(r.to)!)).toBe(1)
    }
    expect(renderKind(spine, "usecase").every((p) => p.issues?.length === 0)).toBe(true)
  })

  it("vòng và hai quan hệ giữa cùng một cặp vẫn tách thành chuỗi đường đi đơn, mỗi cạnh một lần", () => {
    const cyc = [uc(1, { includes: ["UC002"] }), uc(2, { includes: ["UC003"] }), uc(3, { includes: ["UC001"] })]
    const both = [uc(1, { includes: ["UC002"] }), uc(2, { extends: ["UC001"] })]
    for (const useCases of [cyc, both]) {
      const chains = relationChains(useCases)
      expect(chains.flatMap((c) => c.relations)).toHaveLength(useCases.reduce((n, u) => n + u.includes.length + u.extends.length, 0))
      for (const c of chains) expect(new Set(c.nodes).size).toBe(c.nodes.length)
      expect(renderKind(withUseCases(useCases), "usecase").every((p) => p.issues?.length === 0)).toBe(true)
    }
  })

  it("quan hệ sang use case ở feature khác không vẽ (cả hai đầu phải cùng hình); id chết bỏ qua", () => {
    const spine = withUseCases([uc(1, { function_ids: ["FN001"], includes: ["UC002", "UC404"] }), uc(2, { function_ids: ["FN028"] })])
    const parts = partitionUseCases(spine)
    expect(parts).toHaveLength(2)
    expect(parts.flatMap((p) => p.relations)).toEqual([])
  })
})

describe("cạnh actor – use case", () => {
  const hasEdge = (spine: Spine, actorId: string, ucId: string): boolean => partitionUseCases(spine).some((p) => p.associations.some((a) => a.actorId === actorId && a.useCaseId === ucId))

  it("một use case nối MỌI actor của nó trong cùng hình (không còn một actor người mỗi hình)", () => {
    const part = partitionUseCases(FIXTURE).find((p) => ids(p).includes("UC02"))!
    expect(part.associations.filter((a) => a.useCaseId === "UC02").map((a) => a.actorId)).toEqual(["A01", "A02", "A03", "A04"])
  })

  it("actor người bỏ cạnh vào use case bị include / extend khi quan hệ vẽ cùng hình; actor system/time giữ cạnh", () => {
    const spine = withUseCases([uc(1, { actor_ids: ["A01"], includes: ["UC002"] }), uc(2, { actor_ids: ["A01", "A05"] }), uc(3, { actor_ids: ["A01"], extends: ["UC001"] })])
    expect(hasEdge(spine, "A01", "UC001")).toBe(true)
    expect(hasEdge(spine, "A01", "UC002")).toBe(false)
    expect(hasEdge(spine, "A01", "UC003")).toBe(false)
    expect(hasEdge(spine, "A05", "UC002")).toBe(true)
  })

  it("quan hệ không vẽ (khác hình) ⇒ actor giữ cạnh; actor người mất hết cạnh giữ cạnh tới use case id nhỏ nhất", () => {
    const split = withUseCases([uc(1, { function_ids: ["FN001"], includes: ["UC002"] }), uc(2, { function_ids: ["FN028"] })])
    expect(hasEdge(split, "A01", "UC002")).toBe(true)
    const onlyDependent = withUseCases([uc(1, { actor_ids: ["A02"], includes: ["UC002", "UC003"] }), uc(2, { actor_ids: ["A01"] }), uc(3, { actor_ids: ["A01"] })])
    expect(hasEdge(onlyDependent, "A01", "UC002")).toBe(true)
    expect(hasEdge(onlyDependent, "A01", "UC003")).toBe(false)
  })

  it("actor đúng như mô hình: actor tổng quát hiện trên hình, không bung xuống actor lá, actor có con in nghiêng", () => {
    const spine = mutate((s) => {
      s.actors.push({ id: "A10", name: "User", kind: "human", description: "Business Analyst, Administrator." })
      for (const a of s.actors) if (["A02", "A03"].includes(a.id)) a.parent_id = "A10"
      s.use_cases.find((u) => u.id === "UC02")!.actor_ids = ["A10", "A04"]
    })
    const part = partitionUseCases(spine).find((p) => ids(p).includes("UC02"))!
    expect(part.associations.filter((a) => a.useCaseId === "UC02").map((a) => a.actorId)).toEqual(["A04", "A10"])
    const svg = renderKind(spine, "usecase").find((p) => p.source.includes("Log In"))!.source
    expect(svg).toMatch(/font-style="italic"[^>]*>User</)
    expect(svg).not.toMatch(/font-style="italic"[^>]*>Guest</)
  })
})

describe("sơ đồ phân cấp actor", () => {
  const general = (): Spine =>
    mutate((s) => {
      s.actors.push({ id: "A10", name: "User", kind: "human", description: "Business Analyst, Administrator." })
      for (const a of s.actors) if (["A02", "A03"].includes(a.id)) a.parent_id = "A10"
    })

  it("có parent_id hợp lệ ⇒ thêm đúng một hình ở cuối, section §2.1, mọi actor người có mặt, mỗi cạnh một đầu tam giác rỗng", () => {
    const parts = renderKind(general(), "usecase")
    const hierarchy = parts.filter((p) => p.section === ACTOR_HIERARCHY_SECTION)
    expect(hierarchy).toHaveLength(1)
    expect(parts[parts.length - 1]).toBe(hierarchy[0])
    expect(hierarchy[0].issues).toEqual([])
    expect(hierarchy[0]).toMatchObject({ kind: "usecase", format: "svg", owner_kind: null, owner_id: null })
    expect(svgTitleOf(hierarchy[0].source)).toBe("Actor Hierarchy")
    for (const name of ["User", "Business Analyst", "Administrator", "Founder", "Guest"]) expect(hierarchy[0].source).toContain(`>${name}</text>`)
    expect(hierarchy[0].source).not.toContain("Email Service")
    expect(hierarchy[0].source.match(/<polygon /g)!.length).toBe(2) // hai đầu tam giác rỗng
    expect(hierarchy[0].source.match(/<circle /g)!.length).toBe(5) // mỗi actor người một đầu
  })

  it("cạnh không hợp lệ (actor system, tự trỏ, vòng) bị bỏ qua ⇒ không có hình phân cấp", () => {
    const invalid = mutate((s) => {
      s.actors.find((a) => a.id === "A05")!.parent_id = "A01"
      s.actors.find((a) => a.id === "A01")!.parent_id = "A01"
    })
    expect(renderKind(invalid, "usecase").some((p) => p.section === ACTOR_HIERARCHY_SECTION)).toBe(false)
  })

  it("phân cấp nhiều tầng: actor con tầng dưới nằm dưới actor cha, không lỗi bố cục", () => {
    const deep = mutate((s) => {
      s.actors.push({ id: "A10", name: "Registered User", kind: "human", description: "" }, { id: "A11", name: "Member", kind: "human", description: "" })
      s.actors.find((a) => a.id === "A11")!.parent_id = "A10"
      for (const id of ["A01", "A02"]) s.actors.find((a) => a.id === id)!.parent_id = "A11"
      s.actors.find((a) => a.id === "A03")!.parent_id = "A10"
    })
    const hierarchy = renderKind(deep, "usecase").find((p) => p.section === ACTOR_HIERARCHY_SECTION)!
    expect(hierarchy.issues).toEqual([])
    expect(hierarchy.source.match(/<line /g)!.length).toBeGreaterThan(4 * 5) // 4 đoạn generalization + 5 nét mỗi hình que
  })
})

describe("renderer thuần, tất định", () => {
  it("cùng Spine ⇒ cùng SVG; issues rỗng trên fixture; hash đổi khi đổi tên feature hoặc function_ids", () => {
    const a = renderKind(FIXTURE, "usecase")
    expect(renderKind(FIXTURE, "usecase").map((p) => p.source)).toEqual(a.map((p) => p.source))
    expect(a.every((p) => p.format === "svg" && p.issues?.length === 0)).toBe(true)
    const base = a[0].source_hash
    expect(renderKind(mutate((s) => (s.features[0].name = "Renamed")), "usecase")[0].source_hash).not.toBe(base)
    expect(renderKind(mutate((s) => (s.use_cases[0].function_ids = ["FN028"])), "usecase")[0].source_hash).not.toBe(base)
    expect(renderKind(mutate((s) => (s.actors[0].description = "Changed")), "usecase")[0].source_hash).toBe(base)
  })

  it("nhãn theo ngôn ngữ tài liệu: tiêu đề tiếng Việt, ký pháp UML giữ nguyên", () => {
    const vi = RENDERERS.usecase(FIXTURE, null, DIAGRAM_LABELS.vi)
    expect(svgTitleOf(vi[0].source)).toMatch(/^Sơ đồ use case — /)
    expect(vi.map((p) => p.source).join("\n")).toContain("&lt;&lt;include&gt;&gt;")
  })

  it("chữ do người dùng đặt (tên actor, use case, hệ thống) được escape, SVG vẫn hợp lệ", () => {
    const hostile = mutate((s) => {
      s.project.system_name = `Sys <script>alert(1)</script> & "co"`
      s.use_cases[0].name = `Do <b>it</b>`
      s.actors[0].name = `A "x" & <y>`
    })
    for (const p of renderKind(hostile, "usecase")) {
      expect(p.source).not.toMatch(/<script|<b>/)
      expect(p.issues).toEqual([])
    }
  })
})
