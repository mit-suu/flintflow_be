import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { legacyDiagram, normalizeDiagramAt } from "./legacy-diagram.js"
import { planRevert, planTransaction } from "./op-engine.js"
import { ROOT_PATH } from "./op.types.js"
import { spineSchema } from "./spine.schema.js"
import type { Change, Diagram, Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

/** Phần tử `diagrams[]` dạng trước FLF-339: `puml`, không `format` / `source`. */
const toLegacy = (d: unknown): Record<string, unknown> => {
  const { format: _format, source, ...rest } = d as Diagram
  return { ...rest, puml: source }
}
const legacySpine = (spine: Record<string, unknown>) => ({ ...spine, diagrams: (spine.diagrams as Diagram[]).map(toLegacy) })

describe("legacyDiagram", () => {
  it("{ puml } ⇒ { format: puml, source }, bỏ key puml", () => {
    expect(legacyDiagram({ id: "D01", puml: "@startuml" })).toEqual({ id: "D01", format: "puml", source: "@startuml" })
  })

  it("đã có source thì giữ source, vẫn bỏ puml", () => {
    expect(legacyDiagram({ id: "D01", format: "svg", source: "<svg/>", puml: "x" })).toEqual({ id: "D01", format: "svg", source: "<svg/>" })
  })

  it("dạng mới và giá trị không phải object ⇒ trả nguyên", () => {
    const fresh = { id: "D01", format: "svg", source: "<svg/>" }
    expect(legacyDiagram(fresh)).toBe(fresh)
    expect(legacyDiagram(null)).toBeNull()
    expect(legacyDiagram("x")).toBe("x")
  })

  it("normalizeDiagramAt theo path: phần tử, cả mảng, gốc; path khác giữ nguyên", () => {
    const old = { id: "D01", puml: "a" }
    expect(normalizeDiagramAt("diagrams[id=D01]", old)).toEqual({ id: "D01", format: "puml", source: "a" })
    expect(normalizeDiagramAt("diagrams[]", old)).toEqual({ id: "D01", format: "puml", source: "a" })
    expect(normalizeDiagramAt("diagrams", [old])).toEqual([{ id: "D01", format: "puml", source: "a" }])
    expect(normalizeDiagramAt(ROOT_PATH, { diagrams: [old] })).toEqual({ diagrams: [{ id: "D01", format: "puml", source: "a" }] })
    expect(normalizeDiagramAt("actors[id=A01]", old)).toBe(old)
  })
})

describe("spineSchema đọc Spine / baseline snapshot dạng cũ", () => {
  it("diagrams[].puml ⇒ format + source, schema vẫn strict", () => {
    const parsed = spineSchema.parse(legacySpine(FIXTURE as unknown as Record<string, unknown>))
    expect(parsed).toEqual(FIXTURE)
    expect(parsed.diagrams.every((d) => d.format === "puml" && d.source.startsWith("@start") && !("puml" in d))).toBe(true)
    const extra = { ...FIXTURE, diagrams: [{ ...FIXTURE.diagrams[0], foo: 1 }] }
    expect(spineSchema.safeParse(extra).success).toBe(false)
  })
})

describe("op engine với diagrams[] dạng mới / change cũ", () => {
  const svgDiagram: Diagram = {
    id: "D90",
    kind: "context",
    format: "svg",
    source: "<svg/>",
    section: "fixed:1",
    owner_kind: null,
    owner_id: null,
    render_status: "ok",
    source_hash: "h",
    rendered_at: null
  }

  it("add diagrams[] + set diagrams[id=…] chạy được (preprocess không làm mất .shape)", () => {
    const added = planTransaction(FIXTURE, { base_version: 1, by: "u", ops: [{ op: "add", path: "diagrams[]", value: svgDiagram }] }, { startSeq: 1 })
    expect(added.spine.diagrams.find((d) => d.id === "D90")).toEqual(svgDiagram)
    const set = planTransaction(added.spine, { base_version: 2, by: "u", ops: [{ op: "set", path: "diagrams[id=D90]", value: { ...svgDiagram, source: "<svg></svg>" } }] }, { startSeq: 2 })
    expect(set.spine.diagrams.find((d) => d.id === "D90")?.source).toBe("<svg></svg>")
  })

  it("op add / set mang value dạng cũ (puml) ⇒ lưu dạng mới, không còn key puml", () => {
    const legacy = toLegacy({ ...svgDiagram, format: "puml", source: "@startuml\n@enduml" })
    const plan = planTransaction(FIXTURE, { base_version: 1, by: "u", ops: [{ op: "add", path: "diagrams[]", value: legacy }] }, { startSeq: 1 })
    const stored = plan.spine.diagrams.find((d) => d.id === "D90")
    expect(stored).toMatchObject({ format: "puml", source: "@startuml\n@enduml" })
    expect(stored && "puml" in stored).toBe(false)
  })

  it("undo change cũ có puml (path phần tử) ⇒ không revert_conflict, khôi phục dạng mới", () => {
    const target = FIXTURE.diagrams[0]
    const plan = planTransaction(FIXTURE, { base_version: 1, by: "u", ops: [{ op: "set", path: `diagrams[id=${target.id}]`, value: { ...target, render_status: "error", error: "x" } }] }, { startSeq: 1 })
    const legacyChanges: Change[] = plan.changes.map((c) => ({ ...c, projectId: "p", before: toLegacy(c.before), value: toLegacy(c.value) }))
    const reverted = planRevert(plan.spine, legacyChanges, { by: "u", startSeq: 2 })
    expect(reverted.spine).toEqual(FIXTURE)
  })

  it("undo change cũ ở gốc ($) có puml ⇒ không revert_conflict", () => {
    const plan = planTransaction(FIXTURE, { base_version: 1, by: "u", ops: [{ op: "set", path: "project.name", value: "Renamed" }] }, { startSeq: 1 })
    const { spine_version: _a, ...before } = FIXTURE
    const { spine_version: _b, ...current } = plan.spine
    const rootChange: Change = {
      ...plan.changes[0],
      projectId: "p",
      path: ROOT_PATH,
      before: legacySpine(before as unknown as Record<string, unknown>),
      value: legacySpine(current as unknown as Record<string, unknown>)
    }
    const reverted = planRevert(plan.spine, [rootChange], { by: "u", startSeq: 2 })
    expect(without(reverted.spine)).toEqual(without(FIXTURE))
  })
})

const without = ({ spine_version: _v, ...rest }: Spine) => rest
