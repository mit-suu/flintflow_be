/**
 * Sơ đồ gốc của người dùng (mode 1 v3 §4.13): giữ y hình khi import, CR chạm dữ liệu hình ⇒ vị trí "vẽ lại" do code
 * đề xuất, cờ vàng khi hình lệch, bản render không in PlantUML cùng loại. Phần hàm thuần.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { mediaId } from "../render/import-media.js"
import { buildLayoutSections } from "../render/layout-sections.js"
import { runDeterministicCheck } from "../spine/deterministic-check.js"
import { originalDiagramHash, keptOriginalKinds } from "../spine/original-diagram.js"
import { computeSourceHash } from "../spine/source-hash.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import type { IChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { redrawDecision } from "./diagram-location.js"
import { previewAfter } from "./propose.service.js"
import { elementValue, findSpineLocations, originalDiagramLocations, valueText } from "./spine-location.js"
import { checkSpineOps } from "./verify.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FULL: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const CUSTOM = "custom_sections[id=CS01]"
const RENAME_UC = [{ op: "set", path: "use_cases[id=UC01].name", value: "Create Account" }]
const RENAME_DESC = [{ op: "set", path: "use_cases[id=UC01].description", value: "A visitor signs up." }]

/** Fixture + hình PlantUML thật (hash đúng dữ liệu) + phần nối giữ ảnh use case gốc của người dùng. */
const withOriginal = (): Spine => {
  const s = structuredClone(FULL)
  s.diagrams = s.diagrams.map((d) => ({ ...d, source_hash: computeSourceHash(s, d) }))
  s.custom_sections.push({
    id: "CS01",
    heading: "",
    level: 3,
    blocks: [
      { kind: "paragraph", text: "Hình dưới vẽ bằng draw.io.", rows: null, image_ref: null },
      { kind: "image", text: "Figure 2 — Use case", rows: null, image_ref: "word/media/image2.png", diagram: { kind: "usecase", source_hash: originalDiagramHash(s, "usecase") } }
    ],
    source: "import"
  })
  return s
}

const loc = (p: string, ops: unknown[], found_by: IChangeLocation["found_by"] = ["spine_link"]) =>
  ({ path: p, conclusion: "edit", found_by, proposal: { old_text: "", new_text: null, comment_text: null, spine_ops: ops } }) as unknown as IChangeLocation

describe("§4.13 bản render giữ hình gốc", () => {
  it("loại sơ đồ còn ảnh gốc ⇒ không in PlantUML loại đó; ảnh gốc in ở đầu mục; loại khác vẫn in", () => {
    const s = withOriginal()
    expect([...keptOriginalKinds(s)]).toEqual(["usecase"])
    const template = {
      language: "en",
      layout: [
        { order: 0, heading_text: "Use Case Diagram", level: 2, section_id: "fixed:2.2.1" },
        { order: 1, heading_text: "", level: 3, section_id: "custom:CS01" },
        { order: 2, heading_text: "Entity Relationship Diagram", level: 2, section_id: "fixed:3.1.5" }
      ]
    }
    const png = (id: string) => `png:${id}`
    const { sections } = buildLayoutSections(s, template as never, [], { diagramPng: png, partial: true })
    const uc = sections.find((x) => x.id === "fixed:2.2.1")!
    const images = uc.blocks.filter((b) => b.type === "image") as { png: string }[]
    expect(images.map((i) => i.png)).toEqual([`png:${mediaId("word/media/image2.png")}`])
    const erd = sections.find((x) => x.id === "fixed:3.1.5")!
    expect(erd.blocks.some((b) => b.type === "image" && (b as { png: string }).png === "png:D04")).toBe(true)
  })

  it("không có ảnh gốc (mode 2 / ảnh đã bỏ) ⇒ in PlantUML như cũ", () => {
    const s = withOriginal()
    s.custom_sections[0].blocks = s.custom_sections[0].blocks.filter((b) => b.kind !== "image")
    const template = { language: "en", layout: [{ order: 0, heading_text: "Use Case Diagram", level: 2, section_id: "fixed:2.2.1" }] }
    const { sections } = buildLayoutSections(s, template as never, [], { diagramPng: (id) => `png:${id}`, partial: true })
    const uc = sections.find((x) => x.id === "fixed:2.2.1")!
    expect(uc.blocks.some((b) => b.type === "image" && (b as { png: string }).png === "png:D02")).toBe(true)
  })
})

describe("§4.13 cờ vàng original_diagram_stale", () => {
  const rules = (s: Spine) => runDeterministicCheck(s, [], { ruleProfile: MODE1_RULE_PROFILE })
  it("khớp dữ liệu ⇒ không cờ; đổi tên use case ⇒ vàng ở mục Use Case Diagram", () => {
    const s = withOriginal()
    expect(rules(s).filter((c) => c.rule_id === "original_diagram_stale")).toEqual([])
    s.use_cases[0].name = "Create Account"
    expect(rules(s).filter((c) => c.rule_id === "original_diagram_stale")).toEqual([
      expect.objectContaining({ level: "yellow", section_id: "fixed:2.2.1", target_id: "CS01" })
    ])
  })

  it("PlantUML bị ẩn (loại còn ảnh gốc) lệch dữ liệu ⇒ không bắn diagram_stale đỏ; loại không có ảnh gốc vẫn bắn", () => {
    const s = withOriginal()
    s.use_cases[0].name = "Create Account"
    const stale = rules(s).filter((c) => c.rule_id === "diagram_stale").map((c) => c.target_id)
    expect(stale).not.toContain("D02")
    expect(stale).toContain("D01") // ngữ cảnh vẽ cả tên use case, không có ảnh gốc
  })
})

describe("§4.13 C-3 vị trí sơ đồ gốc", () => {
  it("CR chạm use case ⇒ thêm phần nối giữ ảnh use case gốc (found_by diagram); CR chỉ chạm entity ⇒ không", () => {
    const s = withOriginal()
    const hit = findSpineLocations(s, ["use_cases[id=UC01]"], []).find((f) => f.path === CUSTOM)
    expect(hit).toMatchObject({ found_by: ["diagram"], entity_paths: ["fixed:2.2.1"], owner_step: null })
    // Chỉ là ứng viên theo mảng dữ liệu: vị trí thuộc `entities` không gợi hình use case
    expect(originalDiagramLocations(s, [], [{ path: "entities[id=E01]" }, { path: "entities[]" }])).toEqual([])
    expect(originalDiagramLocations(s, [], [{ path: "actors[]" }]).map((f) => f.path)).toEqual([CUSTOM])
  })

  it("CR nhắm mục Use Case Diagram (vd từ cờ vàng) ⇒ có vị trí sơ đồ gốc", () => {
    expect(findSpineLocations(withOriginal(), ["fixed:2.2.1"], []).some((f) => f.path === CUSTOM && f.found_by.includes("diagram"))).toBe(true)
  })
})

describe("§4.13 C-4 đề xuất vẽ lại (code, không AI)", () => {
  it("đổi tên use case ⇒ edit: bỏ đúng khối ảnh, giữ văn xuôi; op hợp lệ và chạy khô ra đúng new_text", () => {
    const s = withOriginal()
    const d = redrawDecision(s, CUSTOM, [loc("use_cases[id=UC01]", RENAME_UC)])!
    expect(d.conclusion).toBe("edit")
    expect(d.reason).toContain("Sơ đồ use case")
    expect(d.proposal.old_text).toBe(valueText(elementValue(s, CUSTOM)))
    expect(d.proposal.new_text).toBe(previewAfter(s, CUSTOM, d.proposal.spine_ops))
    expect(JSON.parse(d.proposal.new_text!).blocks).toEqual([expect.objectContaining({ kind: "paragraph" })])
  })

  it("đổi mô tả (không vẽ lên hình) ⇒ not_related, giữ hình", () => {
    const d = redrawDecision(withOriginal(), CUSTOM, [loc("use_cases[id=UC01]", RENAME_DESC)])!
    expect(d.conclusion).toBe("not_related")
    expect(d.proposal.spine_ops).toEqual([])
  })

  it("hình đã lệch từ trước (CR tạo từ cờ vàng) ⇒ edit dù CR không đổi thêm dữ liệu", () => {
    const s = withOriginal()
    s.use_cases[0].name = "Create Account"
    expect(redrawDecision(s, CUSTOM, [])!.conclusion).toBe("edit")
  })
})

describe("§4.13 C-5 chạy khô", () => {
  const cr = { cr_id: "CR-001" } as IChangeRequest
  it("đổi tên use case + bỏ ảnh gốc ⇒ không báo lỗi đỏ mới (hình PlantUML được vẽ lại ở 3.14)", () => {
    const s = withOriginal()
    const redraw = redrawDecision(s, CUSTOM, [loc("use_cases[id=UC01]", RENAME_UC)])!
    const out = checkSpineOps(s, cr, [
      { ...loc("use_cases[id=UC01]", RENAME_UC), location_id: "L001" },
      { ...loc(CUSTOM, redraw.proposal.spine_ops, ["diagram"]), location_id: "L002" }
    ] as never)
    expect([...out.values()].flat()).toEqual([])
  })

  it("mode 1 không có ảnh gốc: đổi tên use case không bị coi là phát sinh diagram_stale đỏ", () => {
    const s = structuredClone(FULL)
    s.diagrams = s.diagrams.map((d) => ({ ...d, source_hash: computeSourceHash(s, d) }))
    const out = checkSpineOps(s, cr, [{ ...loc("use_cases[id=UC01]", RENAME_UC), location_id: "L001" }] as never)
    expect([...out.values()].flat()).toEqual([])
  })
})
