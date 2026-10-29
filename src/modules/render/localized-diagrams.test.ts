import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Diagram, Spine } from "../spine/spine.types.js"
import { allTargets, renderKind } from "../diagram/renderers/index.js"
import { DIAGRAM_LABELS } from "../diagram/renderers/labels.js"
import { titleCase } from "../diagram/renderers/context.renderer.js"
import { screenFlowTitleOf } from "../diagram/renderers/screen-flow.renderer.js"
import { translationUnits, type TranslationUnit, type UnitValue } from "../translation/translation-units.js"
import { localizeSpine, localizedDiagramSources, renderView } from "./localized-spine.js"

const fixture = (): Spine =>
  spineSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8")))

/** Wireframe model vẽ cho một màn (đã qua padFrame như bản thật). */
const wireframe = (screenName: string): string =>
  [
    "@startsalt",
    "{",
    "  {+",
    "    .",
    "    { . | . | {",
    "      {",
    "        <b>FLINTFLOW",
    `        ${screenName}`,
    "      }",
    "      ..",
    "      Email",
    '      "john@example.com      "',
    "      [ Log in ]",
    "    } | . | . }",
    "    .",
    "  }",
    "}",
    "@endsalt",
    ""
  ].join("\n")

/** Fixture với `diagrams[]` vẽ bằng renderer hiện tại (như sau một lượt vẽ thật) + wireframe model vẽ cho màn đầu. */
const rendered = (): { spine: Spine; wireframeId: string } => {
  const spine = fixture()
  const diagrams: Diagram[] = []
  for (const target of allTargets(spine)) {
    for (const part of renderKind(spine, target.kind, target.owner_id)) {
      diagrams.push({
        id: `D${String(diagrams.length + 1).padStart(2, "0")}`,
        kind: part.kind,
        format: part.format, source: part.source,
        section: part.section,
        owner_kind: part.owner_kind,
        owner_id: part.owner_id,
        render_status: "ok",
        source_hash: part.source_hash,
        rendered_at: "2026-10-13T00:00:00.000Z"
      })
    }
  }
  const layout = diagrams.find((d) => d.kind === "screen_layout")!
  const screen = spine.screens.find((s) => s.id === layout.owner_id)!
  layout.source = wireframe(screen.name)
  spine.diagrams = diagrams
  return { spine, wireframeId: layout.id }
}

/** Tiền tố không có ký tự cú pháp salt / DOT — renderer và `localizeSalt` lọc `[ ]`. */
const toVi = (value: UnitValue): UnitValue => (typeof value === "string" ? `vi: ${value}` : value.map((v) => `vi: ${v}`))
const translate = (units: TranslationUnit[], pick: (u: TranslationUnit) => boolean = () => true): Map<string, UnitValue> =>
  new Map(units.filter(pick).map((u) => [u.key, toVi(u.value)]))
const byKind = (spine: Spine, kind: Diagram["kind"]) => spine.diagrams.filter((d) => d.kind === kind)

describe("localizeSpine + language — nguồn sơ đồ theo ngôn ngữ trong bản xem (FLF-265 N1)", () => {
  it("hình dựng từ Spine vẽ lại bằng chữ đã dịch + nhãn máy tiếng Việt; Spine gốc không đổi", () => {
    const { spine } = rendered()
    const before = structuredClone(spine)
    const units = translationUnits(spine)
    const view = renderView(localizeSpine(spine, units, translate(units), "vi"))

    expect(spine).toEqual(before)
    const human = spine.actors.find((a) => a.kind === "human")!
    expect(byKind(view, "context")[0].source).toContain(`vi: ${human.name}`)
    expect(byKind(view, "context")[0].source).toContain(`vi: ${human.flows_in![0]}`)
    expect(byKind(view, "usecase").map((d) => d.source).join("\n")).toContain(`usecase "vi: ${spine.use_cases[0].name}"`)
    for (const d of byKind(view, "screen_flow")) expect(screenFlowTitleOf(d.source)).toMatch(/^Luồng màn hình của vi: /)
    const erd = byKind(view, "erd")[0].source
    expect(erd).toContain(`entity "vi: ${spine.entities[0].name}"`)
    expect(erd).toContain(`relationship "${DIAGRAM_LABELS.vi.relationVerb}"`)
    const table = byKind(view, "screen_layout").find((d) => d.source.includes("{#"))!
    expect(table.source).toContain(`<b>${DIAGRAM_LABELS.vi.functionColumn} | <b>${DIAGRAM_LABELS.vi.descriptionColumn}`)
    expect(table.source).toMatch(/\| vi: /)
    // Mọi hình dựng từ Spine đều có nguồn mới; cùng id, cùng thứ tự với bản gốc
    expect(view.diagrams.map((d) => d.id)).toEqual(spine.diagrams.map((d) => d.id))
    expect([...localizedDiagramSources(spine, localizeSpine(spine, units, translate(units), "vi")).keys()]).toEqual(spine.diagrams.map((d) => d.id))
  })

  it("wireframe: nhãn đã dịch thay đúng chỗ, dòng tên màn theo tên màn đã dịch; nhãn chưa dịch giữ chữ gốc", () => {
    const { spine, wireframeId } = rendered()
    const layout = spine.diagrams.find((d) => d.id === wireframeId)!
    const screen = spine.screens.find((s) => s.id === layout.owner_id)!
    const units = translationUnits(spine)
    expect(units.find((u) => u.key === `diagrams[id=${wireframeId}].labels`)?.value).toEqual(["Email", "Log in"])

    const full = renderView(localizeSpine(spine, units, translate(units), "vi")).diagrams.find((d) => d.id === wireframeId)!
    expect(full.source).toContain(`        vi: ${screen.name}\n`)
    expect(full.source).toContain("      vi: Email\n")
    expect(full.source).toContain("      [ vi: Log in ]\n")
    expect(full.source).toContain("<b>FLINTFLOW")
    expect(full.source).toContain('"john@example.com      "')

    // Chỉ tên màn đã dịch (nhãn wireframe chưa bấm "Dịch tài liệu")
    const titleOnly = renderView(localizeSpine(spine, units, translate(units, (u) => u.ref.group === "screens"), "vi")).diagrams.find((d) => d.id === wireframeId)!
    expect(titleOnly.source).toBe(layout.source.replace(`        ${screen.name}\n`, `        vi: ${screen.name}\n`))
  })

  it("hình cũ (nguồn khác bản renderer sinh từ Spine hiện tại) ⇒ giữ nguồn gốc, không có trong danh sách cần ảnh riêng", () => {
    const { spine } = rendered()
    const erd = byKind(spine, "erd")[0]
    erd.source = erd.source.replace("skinparam ranksep 20", "skinparam ranksep 30")
    const units = translationUnits(spine)
    const localized = localizeSpine(spine, units, translate(units), "vi")
    expect(byKind(renderView(localized), "erd")[0].source).toBe(erd.source)
    expect(localizedDiagramSources(spine, localized).has(erd.id)).toBe(false)
  })

  it("không truyền ngôn ngữ ⇒ nguồn sơ đồ như bản gốc (hành vi trước N1); hình lỗi không đụng", () => {
    const { spine } = rendered()
    spine.diagrams[0].render_status = "error"
    const units = translationUnits(spine)
    expect(renderView(localizeSpine(spine, units, translate(units))).diagrams).toEqual(spine.diagrams)
    const view = renderView(localizeSpine(spine, units, translate(units), "vi"))
    expect(view.diagrams[0]).toEqual(spine.diagrams[0])
  })

  it("chưa có bản dịch nào ⇒ nhãn máy vẫn tiếng Việt; hình không có nhãn máy nào giữ nguồn gốc", () => {
    const { spine } = rendered()
    const units = translationUnits(spine)
    const localized = localizeSpine(spine, units, new Map(), "vi")
    const view = renderView(localized)
    for (const d of byKind(view, "screen_flow")) expect(screenFlowTitleOf(d.source)).toMatch(/^Luồng màn hình của /)
    // Use case tách hai hình: tiêu đề phần là chữ máy ⇒ đổi
    for (const d of byKind(view, "usecase")) expect(d.source).toMatch(/^title Sơ đồ use case — /m)
    // Sơ đồ ngữ cảnh: bản gốc Title Case nhãn tiếng Anh, bản tiếng Việt giữ nguyên chữ như viết ⇒ vẽ lại, nhãn chưa dịch không bị Title Case
    const human = spine.actors.find((x) => x.kind === "human")!
    expect(byKind(spine, "context")[0].source).toContain(`>${titleCase(human.flows_in![0])}<`)
    expect(byKind(view, "context")[0].source).toContain(`>${human.flows_in![0]}<`)
    expect(localizedDiagramSources(spine, localized).has(byKind(spine, "context")[0].id)).toBe(true)
  })
})
