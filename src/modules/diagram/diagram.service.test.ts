import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose (cùng ngữ nghĩa op-engine.test.ts). */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number; $lte?: number; $in?: unknown[] }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        const n = Number(actual)
        return (e.$gte === undefined || n >= e.$gte) && (e.$lte === undefined || n <= e.$lte)
      }
      return String(actual) === String(expected)
    })
  const bySeq = (a: Doc, b: Doc) => Number(a.seq) - Number(b.seq)
  const Spine = {
    findOne: async (filter: Filter) => copy(spines.find((s) => matches(s, filter)) ?? null),
    exists: async (filter: Filter) => (spines.some((s) => matches(s, filter)) ? { _id: "x" } : null),
    findOneAndUpdate: async (filter: Filter, update: { $set?: Doc; $setOnInsert?: Doc }, options: { upsert?: boolean } = {}) => {
      const doc = spines.find((s) => matches(s, filter))
      if (doc) {
        Object.assign(doc, copy(update.$set ?? {}))
        return copy(doc)
      }
      if (!options.upsert) return null
      const created = { _id: crypto.randomUUID() /* mỗi lần seed một Spine mới, như Mongo — cache đọc khoá theo (_id, version) */, ...filter, ...copy(update.$setOnInsert ?? {}) }
      spines.push(created)
      return copy(created)
    }
  }
  const Change = {
    findOne: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return copy((options.sort?.seq === -1 ? rows[rows.length - 1] : rows[0]) ?? null)
    },
    find: async (filter: Filter) => changes.filter((c) => matches(c, filter)).sort(bySeq).map(copy),
    insertMany: async (docs: Doc[]) => {
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async () => ({})
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
  }
  return { Spine, Change, spines, reset }
})

vi.mock("../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: db.Change }))
// FLF-311: renderChangedIfAvailable hỏi PlantUML có chạy không — test bật / tắt
const plantuml = vi.hoisted(() => ({ reachable: true }))
vi.mock("../../shared/diagram/plantuml.client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/diagram/plantuml.client.js")>()),
  isPlantUmlReachable: async () => plantuml.reachable
}))

// FLF-339: thay renderer của một kind bằng part svg dựng sẵn (chưa kind nào dùng svg thật)
const svgOverride = vi.hoisted(() => ({ parts: null as null | ((kind: string) => unknown[] | null) }))
vi.mock("./renderers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./renderers/index.js")>()
  return {
    ...actual,
    renderKind: (...args: Parameters<typeof actual.renderKind>) => (svgOverride.parts?.(args[1]) as ReturnType<typeof actual.renderKind> | null) ?? actual.renderKind(...args)
  }
})

import { spineSchema } from "../spine/spine.schema.js"
import { Scene } from "../../shared/diagram/svg-scene.js"
import { svgPart } from "./renderers/common.js"
import { renderedDiagramHash } from "../spine/source-hash.js"
import type { Spine } from "../spine/spine.types.js"
import * as repo from "../spine/spine.repository.js"
import { runDeterministicCheck } from "../spine/deterministic-check.js"
import type { CompileCheckResult } from "../../shared/diagram/compile-check.js"
import { createMemoryDiagramStore } from "./diagram-file.store.js"
import { renderKind } from "./renderers/index.js"
import { compileWithFix, defaultDeps, loadDiagramFile, noAutoFix, renderAll, renderChangedIfAvailable, renderDiagram, staleDiagrams, staleRenderedDiagrams, type DiagramServiceDeps } from "./diagram.service.js"
import { applyTransaction } from "../spine/op-engine.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"

const render = (ok: boolean, extra: Partial<CompileCheckResult> = {}): CompileCheckResult =>
  ({
    ok,
    method: ok ? "svg-scan" : "header",
    ...(ok ? {} : { error: "Syntax Error?" }),
    render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: ok ? 200 : 400, diagnostics: {} },
    ...extra
  }) as CompileCheckResult

const makeDeps = (check: DiagramServiceDeps["check"] = async () => render(true)) => {
  const store = createMemoryDiagramStore()
  const deps: Partial<DiagramServiceDeps> = {
    check: vi.fn(check),
    renderPng: async () => Buffer.from("png"),
    store,
    now: () => new Date("2026-09-14T09:00:00.000Z")
  }
  return { deps, store }
}

const seed = async (spine: Spine = FIXTURE) => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: crypto.randomUUID() /* mỗi lần seed một Spine mới, như Mongo — cache đọc khoá theo (_id, version) */, projectId: PROJECT, ...structuredClone(spine) }
}

describe("compileWithFix", () => {
  it("fix trả bản sửa ⇒ compile lại bản đó", async () => {
    const check = vi.fn(async (source: string) => (source.includes("BAD") ? render(false, { line: "2" } as Partial<CompileCheckResult>) : render(true)))
    const fix = vi.fn(async ({ puml }: { puml: string }) => puml.replace("BAD LINE\n", ""))
    const result = await compileWithFix("erd", "@startuml\nBAD LINE\nentity A\n@enduml\n", { ...makeDeps(check).deps, check, fix } as DiagramServiceDeps)
    expect(result).toMatchObject({ ok: true, source: "@startuml\nentity A\n@enduml\n" })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it("hết 2 lần sửa vẫn lỗi ⇒ trả error, giữ text gốc; server chết ⇒ error, không ném", async () => {
    const fix = vi.fn(async ({ puml }: { puml: string }) => `${puml}%`)
    const failing = await compileWithFix("erd", "@startuml\n@enduml\n", { ...makeDeps(async () => render(false)).deps, fix } as DiagramServiceDeps)
    expect(failing).toMatchObject({ ok: false, source: "@startuml\n@enduml\n", error: "Syntax Error?" })
    expect(fix).toHaveBeenCalledTimes(2)

    const down = await compileWithFix("erd", "x", { ...makeDeps(async () => { throw new Error("ECONNREFUSED") }).deps, fix } as DiagramServiceDeps)
    expect(down).toMatchObject({ ok: false })
    expect(down.ok === false && down.error).toContain("ECONNREFUSED")
  })
})

describe("renderAll / renderDiagram qua op engine", () => {
  beforeEach(() => db.reset())

  it("render cả bộ fixture: 19 hình ok (usecase và screen_flow mỗi feature một hình — 6 phần), giữ id D01–D05, một transaction, file SVG+PNG trong store", async () => {
    await seed()
    const { deps, store } = makeDeps()
    const result = await renderAll(PROJECT, { by: USER, deps })

    expect(result.spine_version).toBe(2)
    expect(result.diagrams).toHaveLength(19)
    expect(result.diagrams.every((d) => d.render_status === "ok" && d.source_hash.length === 64)).toBe(true)
    const byKind = Object.fromEntries(
      result.diagrams.filter((d) => !["screen_layout", "screen_flow", "usecase"].includes(d.kind)).map((d) => [d.kind, d.id])
    )
    expect(byKind).toEqual({ context: "D01", erd: "D04" })
    // Sơ đồ use case mỗi feature một hình (6 feature của fixture); phần đầu GIỮ id cũ để baseline đã ký không mất ảnh §2.2.1
    expect(result.diagrams.filter((d) => d.kind === "usecase").map((d) => d.id)).toEqual(["D02", "D02-2", "D02-3", "D02-4", "D02-5", "D02-6"])
    // Một sơ đồ luồng màn cho mỗi feature; phần đầu giữ id cũ
    expect(result.diagrams.filter((d) => d.kind === "screen_flow").map((d) => d.id)).toEqual(["D03", "D03-2", "D03-3", "D03-4", "D03-5", "D03-6"])
    expect(result.diagrams.find((d) => d.owner_id === "S07")?.id).toBe("D05")
    expect(result.diagrams.filter((d) => d.kind === "screen_layout").map((d) => d.id).sort()).toEqual(["D05", "D06", "D07", "D08", "D09"])

    const spine = (await repo.get(PROJECT))!
    expect(spine.diagrams).toHaveLength(19)
    expect(staleDiagrams(spine)).toEqual([])
    expect(runDeterministicCheck(spine).filter((f) => f.level === "red")).toEqual([])
    expect(store.files.size).toBe(38)
    expect((await loadDiagramFile(PROJECT, "D01", "svg", store)).contentType).toBe("image/svg+xml")

    // lần hai: không đổi gì ⇒ không compile, không ghi
    const again = await renderAll(PROJECT, { by: USER, deps })
    expect(again).toMatchObject({ spine_version: 2, rendered: [], removed: [] })
  })

  it(".puml không compile ⇒ render_status=error, không ném, cờ đỏ render_error", async () => {
    await seed()
    const { deps, store } = makeDeps(async () => render(false))
    const result = await renderDiagram(PROJECT, "erd", null, { by: USER, deps })
    expect(result.diagrams[0]).toMatchObject({ id: "D04", render_status: "error", error: "Syntax Error?" })
    expect(store.files.size).toBe(0)
    await expect(loadDiagramFile(PROJECT, "D04", "svg", store)).rejects.toMatchObject({ statusCode: 404, code: "DIAGRAM_NOT_FOUND" })

    const flags = runDeterministicCheck((await repo.get(PROJECT))!)
    expect(flags.filter((f) => f.rule_id === "render_error")).toMatchObject([{ target_id: "D04", remediation_step: "S-4.5" }])
  })

  it("đổi tên actor ⇒ hình context, usecase + luồng màn (tên làn theo actor) stale ⇒ render lại chỉ các hình đó", async () => {
    await seed()
    const { deps } = makeDeps()
    await renderAll(PROJECT, { by: USER, deps })

    const spine = (await repo.get(PROJECT))!
    const actor = spine.actors.find((a) => a.kind === "human")!
    const { applyTransaction } = await import("../spine/op-engine.js")
    await applyTransaction(PROJECT, { base_version: spine.spine_version, ops: [{ op: "set", path: `actors[id=${actor.id}].name`, value: "Renamed" }], by: USER })

    const stale = staleDiagrams((await repo.get(PROJECT))!).map((d) => d.kind)
    expect([...new Set(stale)].sort()).toEqual(["context", "screen_flow", "usecase"])
    const result = await renderAll(PROJECT, { by: USER, deps })
    expect([...result.rendered].sort()).toEqual(["D01", "D02", "D02-2", "D02-3", "D02-4", "D02-5", "D02-6", "D03", "D03-2", "D03-3", "D03-4", "D03-5", "D03-6"])
  })

  it("40 use case chưa có feature của 4 actor ⇒ nhóm theo actor chính, mỗi nhóm một hình D02, D02-2…, phần đầu giữ id cũ", async () => {
    const spine = structuredClone(FIXTURE)
    const human = spine.actors.filter((a) => a.kind === "human").map((a) => a.id)
    spine.use_cases = Array.from({ length: 40 }, (_, i) => ({
      id: `UC${String(i + 1).padStart(3, "0")}`,
      name: `Use Case ${i + 1}`,
      actor_ids: [human[i % human.length]],
      function_ids: [],
      description: "",
      includes: [],
      extends: []
    }))
    await seed(spine)
    const { deps } = makeDeps()
    const result = await renderDiagram(PROJECT, "usecase", null, { by: USER, deps })
    expect(result.removed).toEqual([])
    expect(result.diagrams.map((d) => d.id)).toEqual(["D02", "D02-2", "D02-3", "D02-4"])
    expect((await repo.get(PROJECT))!.diagrams.filter((d) => d.kind === "usecase").map((d) => d.id)).toEqual(["D02", "D02-2", "D02-3", "D02-4"])
  })

  it("dự án đã tách theo id cũ (D02-1, D02-2): không gỡ id nào, `force` mới làm sạch cả hai phần", async () => {
    const spine = structuredClone(FIXTURE)
    const human = spine.actors.filter((a) => a.kind === "human").map((a) => a.id)
    spine.use_cases = Array.from({ length: 40 }, (_, i) => ({
      id: `UC${String(i + 1).padStart(3, "0")}`,
      name: `Use Case ${i + 1}`,
      actor_ids: [human[i % human.length]],
      function_ids: [],
      description: "",
      includes: [],
      extends: []
    }))
    // Hình đã vẽ bằng bản cũ: id `-1`/`-2`, `source_hash` đúng với `actors[]` + `use_cases[]` hiện tại
    const stale = { format: "puml" as const, source: "@startuml\nA01 --> UC001\n@enduml\n", source_hash: renderKind(spine, "usecase")[0].source_hash }
    const base = { kind: "usecase" as const, section: "fixed:2.2.1", owner_kind: null, owner_id: null, render_status: "ok" as const, rendered_at: "2026-09-01T09:10:00.000Z" }
    spine.diagrams = [
      { id: "D02-1", ...base, ...stale },
      { id: "D02-2", ...base, ...stale }
    ]
    await seed(spine)
    const { deps } = makeDeps()

    const result = await renderDiagram(PROJECT, "usecase", null, { by: USER, deps })
    // Phần đầu giữ NGUYÊN id đang có (`D02-1`), không gỡ id nào ⇒ baseline đã ký trỏ `diagram-ref:D02-1`
    // vẫn nạp được ảnh từ store
    expect(result.diagrams.map((d) => d.id)).toEqual(["D02-1", "D02-2", "D02-3", "D02-4"])
    expect(result.removed).toEqual([])
    // `source_hash` tính theo TARGET nên mọi phần chung một giá trị và không phủ code vẽ ⇒ `unchanged()`
    // giữ nguyên cả hai bản cũ: không có tín hiệu tự động nào báo `.puml` đã sai chuẩn
    // Hai phần mới (mỗi actor một hình) được vẽ; hai phần cũ cùng hash nên giữ nguyên bản cũ
    expect(result.rendered).toEqual(["D02-3", "D02-4"])
    for (const d of result.diagrams.slice(0, 2)) expect(d.source).toBe(stale.source)

    // `force: true` (`npm run rerender:usecase`) là đường duy nhất làm cả hai phần đúng chuẩn mới
    const forced = await renderDiagram(PROJECT, "usecase", null, { by: USER, deps, force: true })
    expect(forced.rendered).toEqual(["D02-1", "D02-2", "D02-3", "D02-4"])
    for (const d of forced.diagrams) expect(d.source).not.toMatch(/^A\d+ -->/m)
  })

  it("mặc định không tự sửa: bỏ dòng lỗi làm mất phần tử hình mà vẫn báo ok", async () => {
    expect(defaultDeps().fix).toBe(noAutoFix)
    expect(await noAutoFix({ kind: "erd", puml: "@startuml\nBAD\n@enduml", error: "x", line: "2", attempt: 1 })).toBeNull()
  })

  it("force compile lại hình không đổi; nội dung trùng ⇒ không tăng version", async () => {
    await seed()
    const { deps } = makeDeps()
    await renderAll(PROJECT, { by: USER, deps })
    const forced = await renderAll(PROJECT, { by: USER, deps, force: true })
    expect(forced.rendered).toHaveLength(19)
    expect(forced.spine_version).toBe(2)
  })

  it("hình chuyển sang lỗi ⇒ xoá file cũ; 409 khi ghi ⇒ không lưu file của lô thua", async () => {
    await seed()
    const { deps, store } = makeDeps()
    await renderDiagram(PROJECT, "erd", null, { by: USER, deps })
    expect(store.files.size).toBe(2)

    const spine = (await repo.get(PROJECT))!
    const failing = { ...deps, check: vi.fn(async () => render(false)) }
    await renderDiagram(PROJECT, "erd", null, { by: USER, deps: failing, force: true })
    expect(store.files.size).toBe(0)

    // lô thua khoá lạc quan: dữ liệu nguồn đổi giữa lúc đọc và lúc ghi
    const loser = makeDeps(async () => {
      const current = db.spines[0] as { spine_version: number }
      current.spine_version = spine.spine_version + 10
      return render(true)
    })
    await expect(renderDiagram(PROJECT, "erd", null, { by: USER, deps: loser.deps, force: true })).rejects.toMatchObject({ statusCode: 409 })
    expect(loser.store.files.size).toBe(0)
  })
})

describe("screen_layout do model vẽ (FLF-214)", () => {
  const SALT = ["@startsalt", "{", "  {+", "    Email", "    \"john@example.com  \"", "    [ Log in ]", "  }", "}", "@endsalt", ""].join("\n")

  it("drawLayout trả salt ⇒ lưu salt đó; mặc định không gọi model ⇒ bảng function", async () => {
    await seed()
    const { deps } = makeDeps()
    const drawLayout = vi.fn(async () => SALT)
    const drawn = await renderDiagram(PROJECT, "screen_layout", "S01", { by: USER, deps: { ...deps, drawLayout } })
    expect(drawLayout).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT, userId: USER, screenId: "S01" }))
    expect(drawn.diagrams[0]).toMatchObject({ owner_id: "S01", render_status: "ok", source: SALT })

    // Không cắm drawLayout (test, script) ⇒ bảng function của renderer code
    const plain = await renderDiagram(PROJECT, "screen_layout", "S01", { by: USER, deps, force: true })
    expect(plain.diagrams[0].source).toBe(renderKind(FIXTURE, "screen_layout", "S01")[0].source)
    // Hình khác không gọi model
    await renderDiagram(PROJECT, "erd", null, { by: USER, deps: { ...deps, drawLayout } })
    expect(drawLayout).toHaveBeenCalledTimes(1)
  })

  it("salt của model không compile, model trả null hoặc ném ⇒ bảng function, vẫn ok", async () => {
    await seed()
    const table = renderKind(FIXTURE, "screen_layout", "S01")[0].source
    const { deps } = makeDeps(async (source) => render(source !== SALT))
    for (const drawLayout of [async () => SALT, async () => null, async () => Promise.reject(new Error("no credit"))]) {
      const result = await renderDiagram(PROJECT, "screen_layout", "S01", { by: USER, deps: { ...deps, drawLayout }, force: true })
      expect(result.diagrams[0]).toMatchObject({ render_status: "ok", source: table })
    }
  })
})

describe("renderChangedIfAvailable — FLF-311 vẽ lại sau lô thêm use case / màn", () => {
  beforeEach(() => {
    db.reset()
    plantuml.reachable = true
  })

  const renderedThenRenamed = async (deps: Partial<DiagramServiceDeps>) => {
    await seed()
    const rendered = await renderAll(PROJECT, { by: USER, deps })
    // Đổi tên actor ⇒ các hình đã vẽ của actor đó cũ đi (đúng tập cờ diagram_stale)
    await applyTransaction(PROJECT, { base_version: rendered.spine_version, by: USER, ops: [{ op: "set", path: "actors[id=A02].name", value: "Lead Analyst" }] })
    const spine = (await repo.get(PROJECT))!
    expect(staleRenderedDiagrams(spine).length).toBeGreaterThan(0)
    return spine
  }

  it("vẽ lại hình đã cũ + bố cục màn mới trong một lượt; không còn hình cũ", async () => {
    const { deps } = makeDeps()
    const before = await renderedThenRenamed(deps)
    const newScreen = before.screens.find((s) => !before.diagrams.some((d) => d.kind === "screen_layout" && d.owner_id === s.id))!.id

    const result = await renderChangedIfAvailable(PROJECT, [newScreen], { by: USER, deps })

    expect(result).not.toBeNull()
    const after = (await repo.get(PROJECT))!
    expect(staleRenderedDiagrams(after)).toEqual([])
    expect(after.diagrams.some((d) => d.kind === "screen_layout" && d.owner_id === newScreen && d.render_status === "ok")).toBe(true)
  })

  it("PlantUML không chạy ⇒ null, không ghi gì, không ném", async () => {
    const { deps } = makeDeps()
    const before = await renderedThenRenamed(deps)
    plantuml.reachable = false

    await expect(renderChangedIfAvailable(PROJECT, ["S02"], { by: USER, deps })).resolves.toBeNull()
    expect((await repo.get(PROJECT))?.spine_version).toBe(before.spine_version)
  })
})

describe("đường vẽ svg (FLF-339)", () => {
  const contextScene = (overlap: boolean): Scene => {
    const scene = new Scene()
    scene.rect("A", 0, 0, 150, 54, { name: "Analyst" })
    scene.text("A.name", 75, 32, "Analyst", { owner: "A", bold: true })
    scene.circle("P", 400, 27, 60, { name: "FlintFlow" })
    scene.line("F", [150, 27], [340, 27], { name: "Requirement List" })
    scene.arrow("F", "classic")
    scene.label("F", "Requirement List")
    if (overlap) scene.text("X", 245, 30, "Overlapping text")
    return scene
  }
  const svgParts = (overlap: boolean) => () => {
    const part = svgPart(contextScene(overlap), { allowBends: false }, { kind: "context", section: "fixed:1", owner_kind: null, owner_id: null })
    return [{ ...part, source_hash: renderedDiagramHash(FIXTURE, { kind: "context", owner_id: null }) }]
  }

  beforeEach(() => {
    db.reset()
    repo.clearReadCache()
    svgOverride.parts = null
  })

  it("svg sạch ⇒ ok, format svg, không gọi check / fix, lưu svg = source và png của resvg", async () => {
    await seed()
    const { deps, store } = makeDeps()
    const fix = vi.fn(async () => null)
    const renderSvgPng = vi.fn(async () => Buffer.from("svg-png"))
    svgOverride.parts = (kind) => (kind === "context" ? svgParts(false)() : null)
    const result = await renderDiagram(PROJECT, "context", null, { by: USER, deps: { ...deps, fix, renderSvgPng } })
    const d = result.diagrams[0]
    expect(d).toMatchObject({ format: "svg", render_status: "ok" })
    expect(d.source).toMatch(/^<\?xml[\s\S]*<svg /)
    expect(deps.check).not.toHaveBeenCalled()
    expect(fix).not.toHaveBeenCalled()
    expect((await store.load(PROJECT, d.id, "svg"))?.data.toString("utf8")).toBe(d.source)
    expect((await store.load(PROJECT, d.id, "png"))?.data.toString()).toBe("svg-png")
  })

  it("svg vi phạm bố cục ⇒ error nêu tên phần tử, không lưu file, file cũ còn nguyên; lỗi lặp y hệt ⇒ không ghi", async () => {
    await seed()
    const { deps, store } = makeDeps()
    const first = await renderDiagram(PROJECT, "context", null, { by: USER, deps })
    const id = first.diagrams[0].id
    const oldSvg = (await store.load(PROJECT, id, "svg"))?.data.toString()
    expect(oldSvg).toBeDefined()

    const renderSvgPng = vi.fn(async () => Buffer.from("never"))
    svgOverride.parts = (kind) => (kind === "context" ? svgParts(true)() : null)
    // cùng hash dữ liệu với hình puml đang `ok` ⇒ phải `force` (thật ra đổi engine làm đổi hash — xem source-hash.test)
    const broken = await renderDiagram(PROJECT, "context", null, { by: USER, deps: { ...deps, renderSvgPng }, force: true })
    expect(broken.diagrams[0]).toMatchObject({ format: "svg", render_status: "error" })
    expect(broken.diagrams[0].error).toMatch(/^Sơ đồ vi phạm bố cục: .*"Overlapping text"/)
    expect(renderSvgPng).not.toHaveBeenCalled()
    expect((await store.load(PROJECT, id, "svg"))?.data.toString()).toBe(oldSvg)

    const again = await renderDiagram(PROJECT, "context", null, { by: USER, deps: { ...deps, renderSvgPng }, force: true })
    expect(again.rendered).toEqual([])
    expect(again.spine_version).toBe(broken.spine_version)
  })

  it("resvg ném ⇒ error `svg: …`, không lưu file", async () => {
    await seed()
    const { deps, store } = makeDeps()
    svgOverride.parts = (kind) => (kind === "context" ? svgParts(false)() : null)
    const renderSvgPng = vi.fn(async () => Promise.reject(new Error("svg too large")))
    const result = await renderDiagram(PROJECT, "context", null, { by: USER, deps: { ...deps, renderSvgPng } })
    expect(result.diagrams[0]).toMatchObject({ render_status: "error", error: "svg: svg too large" })
    expect(await store.load(PROJECT, result.diagrams[0].id, "svg")).toBeNull()
  })
})
