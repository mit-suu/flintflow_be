import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { Scene } from "../../shared/diagram/svg-scene.js"
import type { Renderer } from "../diagram/renderers/common.js"
import { svgPart } from "../diagram/renderers/common.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"

/** Renderer svg giả cho `context` (chưa kind nào dùng svg thật): tên actor đầu tiên trong hộp rộng cố định 160px. */
const fakeContext: Renderer = (spine) => {
  const scene = new Scene()
  scene.rect("A", 0, 0, 160, 54, { name: "actor" })
  scene.text("A.name", 80, 32, spine.actors[0].name, { owner: "A", bold: true })
  return [svgPart(scene, { allowBends: false }, { kind: "context", section: "fixed:1", owner_kind: null, owner_id: null })]
}

vi.mock("../diagram/renderers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagram/renderers/index.js")>()
  return { ...actual, RENDERERS: { ...actual.RENDERERS, context: fakeContext } }
})

const { changedDiagramSources, localizeDiagrams } = await import("./localized-diagrams.js")

const canonical = (): Spine => {
  const spine = spineSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8")))
  spine.actors[0].name = "Analyst"
  const [part] = fakeContext(spine)
  spine.diagrams = spine.diagrams.map((d) => (d.kind === "context" ? { ...d, format: "svg", source: part.source } : d))
  return spine
}

const localizedView = (spine: Spine, name: string): Spine => {
  const view = structuredClone(spine)
  view.actors[0].name = name
  localizeDiagrams(spine, view, "vi", new Map())
  return view
}

describe("localizeDiagrams — hình svg (FLF-339)", () => {
  it("bản dịch vừa hộp ⇒ nguồn svg theo ngôn ngữ, changedDiagramSources mang format svg", () => {
    const spine = canonical()
    const view = localizedView(spine, "Chuyên viên")
    const context = view.diagrams.find((d) => d.kind === "context")!
    expect(context.source).toContain("Chuyên viên")
    expect(changedDiagramSources(spine, view).get(context.id)).toEqual({ format: "svg", source: context.source })
  })

  it("bản dịch làm vỡ bố cục (tên tràn hộp) ⇒ giữ nguồn gốc ⇒ tài liệu dùng ảnh gốc", () => {
    const spine = canonical()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const view = localizedView(spine, "Chuyên viên phân tích nghiệp vụ cao cấp của tổ chức")
    const context = view.diagrams.find((d) => d.kind === "context")!
    expect(context.source).toBe(spine.diagrams.find((d) => d.kind === "context")!.source)
    expect(changedDiagramSources(spine, view).has(context.id)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("text_overflow"))
    warn.mockRestore()
  })
})
