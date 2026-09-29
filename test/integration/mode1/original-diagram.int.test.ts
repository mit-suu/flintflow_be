/**
 * Sơ đồ gốc của người dùng (mode 1 v3 §4.13) trên Mongo + GridFS thật, AI giả:
 * upload SRS có hình use case vẽ sẵn ⇒ 0.0 giữ y hình ⇒ CR đổi tên use case ⇒ C-3 thêm vị trí "vẽ lại hình" (code, không
 * AI) ⇒ duyệt ⇒ 0.1 bỏ ảnh gốc (in sơ đồ FlintFlow); từ chối ⇒ giữ ảnh gốc + cờ vàng `original_diagram_stale`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../../setup.js"
import { CR_BODY, detail, promptsOf, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { createMode1Project, fakeCrClarify, mode1Api, promptLocations } from "../../helpers/mode1.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { DocxPackage } from "../../../src/modules/docx-ooxml/index.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { clearImportMediaCache } from "../../../src/modules/render/import-media.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

const PNG = buildPlaceholderPng(12, 7, 0x40)
const NEW_NAME = "Sign In"

/** C-2 ⇒ đích UC-02; C-4 đổi tên UC-02, còn lại không liên quan. Vị trí sơ đồ gốc không được gửi AI. */
const route = (p: string) => {
  if (p.includes("# CR Clarify")) return fakeCrClarify({ entity_paths: ["use_cases[id=UC-02]"], keywords: [] })(p)
  if (p.includes("# CR Propose"))
    return JSON.stringify({
      locations: promptLocations(p).map((l) =>
        l.path === "use_cases[id=UC-02]"
          ? { location_id: l.location_id, conclusion: "edit", reason: "Rename", spine_ops: [{ op: "set", path: `${l.path}.name`, value: NEW_NAME }] }
          : { location_id: l.location_id, conclusion: "not_related", reason: "Other", spine_ops: [] }
      )
    })
  return undefined
}

beforeEach(() => {
  resetCrMock(route)
  clearImportMediaCache()
})

const importWithDiagram = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx({ images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] }))).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  await c.patch("/import/fields", { import_id: id, confirm_all: true })
  const fin = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
  expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)
  return { projectId, c }
}

const mediaOf = async (projectId: string, version: string): Promise<Buffer[]> => {
  const v = (await DocVersion.findOne({ projectId, version }).lean())!
  const pkg = await DocxPackage.load(await docFileStore().load(v.file_ref))
  return Promise.all(pkg.partNames().filter((n) => n.startsWith("word/media/")).map(async (n) => (await pkg.binary(n))!))
}

const keptImages = async (projectId: string) =>
  (await spineRepository.get(projectId))!.custom_sections.flatMap((c) => c.blocks).filter((b) => b.kind === "image" && b.diagram)

/** CR đổi tên UC-02 tới `in_review`; trả vị trí sơ đồ gốc + group của nó. */
const renameToReview = async (c: ReturnType<typeof mode1Api>) => {
  const res = await c.post("/change-requests", { title: "Rename login", description: `Rename use case UC-02 to "${NEW_NAME}".`, ...CR_BODY })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  const cr = `/change-requests/${res.body.data.change_request.cr_id as string}`
  detail(await c.post(`${cr}/clarify`))
  const impact = detail(await c.post(`${cr}/impact`))
  const diagram = impact.locations.find((l) => l.found_by.includes("diagram"))
  expect(diagram, "C-3 phải thêm vị trí sơ đồ gốc").toBeTruthy()
  expect(diagram!.path).toMatch(/^custom_sections\[id=CS\d+\]$/)

  const proposed = detail(await c.post(`${cr}/propose`))
  // Vị trí sơ đồ gốc không vào prompt C-4: code tự kết luận
  expect(promptsOf("# CR Propose").flatMap(promptLocations).map((l) => l.path)).not.toContain(diagram!.path)
  const redraw = proposed.locations.find((l) => l.location_id === diagram!.location_id)!
  expect(redraw.conclusion).toBe("edit")
  expect(redraw.proposal?.spine_ops).toEqual([expect.objectContaining({ op: "remove", path: `${diagram!.path}.blocks[image_ref=word/media/image1.png]` })])

  // C-5: đổi tên use case + bỏ ảnh gốc không bị coi là phát sinh lỗi đỏ (hình vẽ lại ở 3.14)
  expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
  const submitted = detail(await c.post(`${cr}/submit`))
  const group = submitted.groups.find((g) => g.location_ids.includes(diagram!.location_id))!
  return { cr, submitted, diagramGroup: group }
}

describe("§4.13 sơ đồ gốc của người dùng", () => {
  it("0.0 giữ y hình use case của người dùng", async () => {
    const { projectId } = await importWithDiagram()
    expect(await keptImages(projectId)).toHaveLength(1)
    expect((await mediaOf(projectId, "0.0")).some((m) => m.equals(PNG))).toBe(true)
  })

  it("CR đổi tên use case ⇒ đề xuất vẽ lại; duyệt ⇒ 0.1 bỏ ảnh gốc, không cờ hình lệch", async () => {
    const { projectId, c } = await importWithDiagram()
    const { cr, submitted } = await renameToReview(c)
    let last = submitted
    for (const g of submitted.groups) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
    expect(last.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })

    const spine = (await spineRepository.get(projectId))!
    expect(spine.use_cases.find((u) => u.id === "UC-02")?.name).toBe(NEW_NAME)
    expect(await keptImages(projectId)).toEqual([])
    expect(spine.flags.filter((f) => f.rule_id === "original_diagram_stale" && !f.resolved_at)).toEqual([])
    expect((await mediaOf(projectId, "0.1")).some((m) => m.equals(PNG))).toBe(false)
  })

  it("từ chối group vẽ lại ⇒ 0.1 giữ ảnh gốc, cờ vàng hình gốc lệch dữ liệu", async () => {
    const { projectId, c } = await importWithDiagram()
    const { cr, submitted, diagramGroup } = await renameToReview(c)
    const others = submitted.groups.filter((g) => g.group_id !== diagramGroup.group_id)
    await c.post(`${cr}/groups/${diagramGroup.group_id}/decision`, { decision: "rejected", reason: "Giữ hình vẽ tay của khách", base_version: await c.spineVersion() })
    let last = submitted
    for (const g of others) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
    expect(last.change_request.status).toBe("written")

    expect(await keptImages(projectId)).toHaveLength(1)
    const spine = (await spineRepository.get(projectId))!
    expect(spine.flags.filter((f) => f.rule_id === "original_diagram_stale" && !f.resolved_at)).toEqual([
      expect.objectContaining({ level: "yellow", section_id: "fixed:2.2.1" })
    ])
    expect((await mediaOf(projectId, "0.1")).some((m) => m.equals(PNG))).toBe(true)
  })
})
