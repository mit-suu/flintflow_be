import { beforeEach, describe, expect, it, vi } from "vitest"
import { DocxPackage, MAIN_PART } from "../docx-ooxml/index.js"
import { NS, wAll } from "../docx-ooxml/xml.js"
import type { RenderedDocument, RenderedSection } from "../render/rendered-document.types.js"
import { FORWARD_DECISIONS, V1_HEADINGS, V1_HEADING_KEYS, V2_HEADINGS, buildV1Source, buildV2Template, forwardPlan } from "./base-file-fixtures.test-helper.js"

// Giả lập kết quả kiểm cấu trúc: lượt dựng đầu "phát hiện" một lỗi do khối đã chép gây ra (quy được / không quy được về mục)
const control = vi.hoisted(() => ({ calls: 0, mode: "attributable" as "attributable" | "unattributable" | "none" }))

vi.mock("./ooxml-transplant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ooxml-transplant.js")>()
  return {
    ...actual,
    validateDocxStructure: async (pkg: Parameters<typeof actual.validateDocxStructure>[0]) => {
      const real = await actual.validateDocxStructure(pkg)
      control.calls += 1
      // Lần 1 = mẫu đích (baseline), lần 2 = kết quả lượt dựng đầu
      if (control.calls !== 2 || control.mode === "none") return real
      if (control.mode === "unattributable") return [...real, "XML hỏng: word/styles.xml: giả lập"]
      const doc = await pkg.requireXml(MAIN_PART)
      const embed = wAll(doc, "p").flatMap((p) => Array.from(p.getElementsByTagName("*"))).map((e) => e.getAttributeNS(NS.r, "embed")).find((v) => !!v)
      return [...real, `word/document.xml: blip@r:embed="${embed}" không có trong rels`]
    }
  }
})

const { buildBaseFile } = await import("./build-base-file.js")

const section = (id: string, body: string): RenderedSection => ({ id, number: "", heading: id, level: 1, blocks: [{ type: "paragraph", runs: [{ text: body }] }] })
const renderedDoc = (sections: RenderedSection[]): RenderedDocument => ({
  projectId: "p", projectName: "Demo", version: "v1.0", source: "baseline", generatedAt: "2026-11-10T00:00:00.000Z", sections, recordOfChanges: []
})

const input = async () => ({
  target: await buildV2Template(),
  targetHeadings: V2_HEADINGS,
  oldHeadings: V1_HEADINGS,
  ...forwardPlan(),
  decisions: FORWARD_DECISIONS,
  direction: "forward" as const,
  source: { buffer: await buildV1Source(), headingKeys: V1_HEADING_KEYS },
  spineOnly: new Set(["fixed:4.1"]),
  renderFromSpine: async (ids: readonly string[]) => renderedDoc(ids.map((id) => section(id, `spine body of ${id}`)))
})

beforeEach(() => {
  control.calls = 0
  control.mode = "attributable"
})

describe("buildBaseFile — lùi theo mục khi kiểm cấu trúc lỗi", () => {
  it("lỗi quy được về một mục ⇒ chỉ mục đó dựng lại từ Spine (cờ vàng), mục khác vẫn là khối chép", async () => {
    const result = await buildBaseFile(await input())
    expect(result.fellBackToSpine).toBe(false)
    expect(result.problems).toEqual([])
    // Ảnh nằm ở mục Introduction
    expect(result.sections.find((s) => s.key === "n0")).toMatchObject({ mode: "spine", flag: "yellow" })
    expect(result.sections.find((s) => s.key === "n1")?.mode).toBe("transplant")
    const doc = await DocxPackage.load(result.buffer).then((p) => p.requireXml(MAIN_PART))
    const text = wAll(doc, "t").map((t) => t.textContent).join("|")
    expect(text).toContain("spine body of fixed:1.1")
    expect(text).toContain("Overview text v1")
    expect(text).not.toContain("Purpose paragraph v1")
    expect(result.warnings.some((w) => w.includes("fixed:1.1"))).toBe(true)
  })

  it("lỗi không quy được về mục nào ⇒ dựng lại toàn file từ Spine", async () => {
    control.mode = "unattributable"
    const result = await buildBaseFile(await input())
    expect(result.fellBackToSpine).toBe(true)
    expect(result.sections.filter((s) => s.old_key && s.mode === "transplant")).toHaveLength(0)
  })
})
