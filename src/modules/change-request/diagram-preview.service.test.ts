/**
 * Hình xem trước của vị trí sơ đồ gốc (§4.13): vẽ từ dữ liệu SAU đề xuất của CR, không ghi gì. Repository + model mock trong
 * bộ nhớ; PlantUML / resvg thay bằng hàm giả.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { originalDiagramHash } from "../spine/original-diagram.js"
import { computeSourceHash } from "../spine/source-hash.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"

const store = vi.hoisted(() => ({ spine: null as unknown, locations: [] as unknown[] }))
vi.mock("../spine/spine.repository.js", () => ({
  SPINE_NOT_FOUND: "SPINE_NOT_FOUND",
  get: async () => (store.spine ? { ...(store.spine as object), projectId: "p1" } : null)
}))
vi.mock("./change-location.model.js", () => ({ ChangeLocation: { find: async () => store.locations } }))

const { diagramPreview } = await import("./diagram-preview.service.js")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FULL: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withOriginal = (): Spine => {
  const s = structuredClone(FULL)
  s.diagrams = s.diagrams.map((d) => ({ ...d, source_hash: computeSourceHash(s, d) }))
  s.custom_sections.push({
    id: "CS01",
    heading: "",
    level: 3,
    blocks: [{ kind: "image", text: "Figure 2 - Use case", rows: null, image_ref: "word/media/image2.png", diagram: { kind: "usecase", source_hash: originalDiagramHash(s, "usecase") } }],
    source: "import"
  })
  return s
}

/** Nguồn hình (PlantUML hoặc SVG) đã đưa đi vẽ. */
const pumlSeen: string[] = []
const deps = {
  check: async (source: string) => ({ ok: true as const, render: { data: Buffer.from(source) } }),
  renderPng: async (source: string) => {
    pumlSeen.push(source)
    return Buffer.from("png")
  },
  renderSvgPng: async (svg: string) => {
    pumlSeen.push(svg)
    return Buffer.from("png")
  },
  store: {} as never,
  fix: async () => null,
  drawLayout: (async () => null) as never,
  renderContext: async () => ({}),
  loadOriginalImage: async (_p: string, part: string) => (part === "word/media/image2.png" ? { mime: "image/jpeg" as const, data: Buffer.from("orig").toString("base64") } : null),
  now: () => new Date()
}

const cr = { projectId: "p1", cr_id: "CR-001" } as never

describe("diagramPreview", () => {
  beforeEach(() => {
    pumlSeen.length = 0
    store.spine = withOriginal()
    store.locations = [
      { location_id: "L1", path: "custom_sections[id=CS01]", found_by: ["diagram"], conclusion: "edit", proposal: null },
      {
        location_id: "L2",
        path: "use_cases[id=UC01]",
        found_by: ["spine_link"],
        conclusion: "edit",
        proposal: { spine_ops: [{ op: "set", path: "use_cases[id=UC01].name", value: "Enrollz" }] }
      }
    ]
  })

  it("vẽ sơ đồ từ dữ liệu sau đề xuất của CR (tên use case mới), trả PNG + số phần", async () => {
    const out = await diagramPreview(cr, "L1", "usecase", null, { part: 0 }, deps as never)
    expect(out.image.toString()).toBe("png")
    expect(out.mime).toBe("image/png")
    expect(out.parts).toBeGreaterThan(0)
    // Use case tách theo feature ⇒ gom đủ các phần
    for (let part = 1; part < out.parts; part++) await diagramPreview(cr, "L1", "usecase", null, { part: part }, deps as never)
    expect(pumlSeen.join("\n")).toContain("Enrollz")
    // Chạy khô: Spine trong kho giữ tên cũ
    expect((store.spine as Spine).use_cases.find((u) => u.id === "UC01")?.name).toBe("Register Account")
  })

  it("vị trí không giữ ảnh gốc loại đó / không phải vị trí sơ đồ ⇒ CR_LOCATION_NOT_FOUND", async () => {
    await expect(diagramPreview(cr, "L1", "erd", null, { part: 0 }, deps as never)).rejects.toMatchObject({ code: "CR_LOCATION_NOT_FOUND" })
    await expect(diagramPreview(cr, "L2", "usecase", null, { part: 0 }, deps as never)).rejects.toMatchObject({ code: "CR_LOCATION_NOT_FOUND" })
  })

  it("variant=original ⇒ ảnh gốc của file ở khối đó, đúng loại ảnh", async () => {
    const out = await diagramPreview(cr, "L1", "usecase", null, { variant: "original" }, deps as never)
    expect(out.image.toString()).toBe("orig")
    expect(out.mime).toBe("image/jpeg")
    expect(out.parts).toBe(1)
  })

  it("máy chủ vẽ hình lỗi ⇒ 422 DIAGRAM_PREVIEW_FAILED", async () => {
    const broken = { ...deps, check: async () => Promise.reject(new Error("down")), renderSvgPng: async () => Promise.reject(new Error("resvg")) }
    await expect(diagramPreview(cr, "L1", "usecase", null, { part: 0 }, broken as never)).rejects.toMatchObject({ code: "DIAGRAM_PREVIEW_FAILED", statusCode: 422 })
  })
})
