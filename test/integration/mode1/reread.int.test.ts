/**
 * FLF-360 — AI quá tải tạm thời lúc import: tự đọc lại ảnh sơ đồ và lô chữ trong lượt I-4; ảnh vẫn chưa đọc được sau bản
 * 0.1 thì job nền đọc lại (không tạo version mới, dấu đoạn FLF-366 cập nhật). Mongo thật + provider giả; giả lập 503 cho
 * vision / chữ qua `mockOverrides` như các test import khác.
 *
 * `executeWithInRequestRetry` thay bằng một lượt (không chờ 2 s / 6 s thật): số lượt gọi provider = số lượt I-4 gọi, đếm được.
 * Giãn cách đọc lại của I-4 = 0 (`IMPORT_AI_RETRY_BACKOFF_MS=0,0,0` trong vitest.config).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/shared/ai/retry.service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/shared/ai/retry.service.js")>()),
  delay: async () => undefined,
  executeWithInRequestRetry: async <T>(fn: (attempt: number) => Promise<T>) => fn(0)
}))

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { AiActionError } from "../../../src/shared/ai/ai-action.types.js"
import { estimateExtraction, runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { runImageReread } from "../../../src/modules/import/reread-jobs.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { originalDiagramHash } from "../../../src/modules/spine/original-diagram.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { clearImportMediaCache } from "../../../src/modules/render/import-media.js"

const PNG = buildPlaceholderPng(12, 7, 0x40)
const USECASE_IMAGE = { srs: { images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] } }
const overloaded = () => new AiActionError(503, "high demand (đã thử gemini-3.5-flash, gemini-3.6-flash)", "GEMINI_OVERLOADED")
const isDiagram = (prompt: string) => prompt.includes("# Read Diagram Image")
const isText = (prompt: string, section: string) => prompt.includes("# Import Extract") && prompt.includes(`Section (registry id): ${section}`)

/** Đếm lượt gọi theo loại; `fail(prompt, n)` trả lỗi cho lượt thứ n (1-based) của loại đó, không thì đường mặc định. */
const scripted = (fail: { diagram?: (n: number) => Error | null; text?: (n: number) => Error | null; section?: string }) => {
  const count = { diagram: 0, text: 0 }
  mockOverrides.next = (prompt) => {
    if (isDiagram(prompt)) {
      const err = fail.diagram?.(++count.diagram)
      if (err) return err
    }
    if (fail.section && isText(prompt, fail.section)) {
      const err = fail.text?.(++count.text)
      if (err) return err
    }
    return fakeMode1(prompt)
  }
  return count
}

const draftOf = async (importId: string, section = "fixed:2.2.1") => (await ExtractionDraft.findOne({ import_id: importId, section_id: section }).lean())!

beforeEach(() => {
  resetMockLlm()
  clearImportMediaCache()
  mockOverrides.next = fakeMode1
})

describe("FLF-360 — đọc lại ảnh sơ đồ trong lượt import", () => {
  it.each([503, 529])("quá tải HTTP %i lần đầu, đọc lại được ⇒ dữ liệu ảnh vào draft như lần đọc đầu, loại ảnh thật; import không dừng", async (status) => {
    const { projectId, userId, importId } = await importAtExtracting(USECASE_IMAGE)
    const count = scripted({ diagram: (n) => (n === 1 ? new AiActionError(status, "Overloaded", status === 529 ? "ANTHROPIC_ERROR" : "GEMINI_OVERLOADED") : null) })
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused).toBeNull()
    expect(run.doc.status).toBe("baselining")
    expect(count.diagram).toBe(2)
    const draft = await draftOf(importId)
    expect(draft.diagram_images.map((i) => i.kind)).toEqual(["usecase"])
    expect(draft.fields.some((f) => f.path.startsWith("actors[") && f.value === "Guest" && f.origin === "vision")).toBe(true)
    expect((await ImportedDocument.findById(importId).lean())!.reread).toBeNull()

    // Finalize: Guest + quan hệ từ ảnh vào Spine, không cờ ảnh chưa đọc
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.some((a) => a.name === "Guest")).toBe(true)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread")).toEqual([])
  })

  it("vẫn quá tải sau mọi lượt đọc lại ⇒ giữ ảnh gốc + cờ vàng, import không bị chặn (không paused)", async () => {
    const { projectId, userId, importId } = await importAtExtracting(USECASE_IMAGE)
    const count = scripted({ diagram: () => overloaded() })
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused).toBeNull()
    expect(run.doc.status).toBe("baselining")
    // 1 lượt đầu + 3 lượt đọc lại (IMPORT_AI_RETRY_BACKOFF_MS có 3 phần tử)
    expect(count.diagram).toBe(4)
    expect((await draftOf(importId)).diagram_images.map((i) => i.kind)).toEqual(["unavailable"])
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread")).toHaveLength(1)
    expect(spine.custom_sections.flatMap((c) => c.blocks).some((b) => b.kind === "image" && b.image_ref === "word/media/image1.png")).toBe(true)
  })

  it("hết credit giữa lượt đọc lại ⇒ paused credits; chạy tiếp ⇒ đọc lại tiếp, xong", async () => {
    const { projectId, userId, importId } = await importAtExtracting(USECASE_IMAGE)
    let credits = true
    scripted({ diagram: (n) => (n === 1 ? overloaded() : credits ? new AiActionError(402, "Insufficient credits", "INSUFFICIENT_CREDIT") : null) })
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused?.reason).toBe("credits")
    expect(run.doc.status).toBe("extracting")
    expect((await draftOf(importId)).diagram_images.map((i) => i.kind)).toEqual(["unavailable"])
    // Ước tính credit còn lại tính cả ảnh sẽ đọc lại (mục đã xong); lượt lỗi được hoàn nên mỗi ảnh trừ tối đa một lần
    expect(await estimateExtraction(projectId, run.doc)).toMatchObject({ text_batches: 0, diagram_images: 1, ai_calls: 1 })
    credits = false
    const again = await runExtraction(projectId, userId, importId)
    expect(again.doc.paused).toBeNull()
    expect(again.doc.status).toBe("baselining")
    expect((await draftOf(importId)).diagram_images.map((i) => i.kind)).toEqual(["usecase"])
  })

  it.each(["ANTHROPIC_KEY_MISSING", "GEMINI_KEY_MISSING"])("không đọc lại ảnh khi thiếu khoá %s / lỗi AI không tự khỏi (400)", async (keyCode) => {
    const a = await importAtExtracting(USECASE_IMAGE)
    const noVision = scripted({ diagram: () => new AiActionError(500, "Vision API key is missing.", keyCode) })
    await runExtraction(a.projectId, a.userId, a.importId)
    expect(noVision.diagram).toBe(1)
    expect((await draftOf(a.importId)).diagram_images.map((i) => i.kind)).toEqual(["unsupported"])

    resetMockLlm()
    clearImportMediaCache()
    const b = await importAtExtracting(USECASE_IMAGE)
    const bad = scripted({ diagram: () => new AiActionError(400, "Invalid image payload", "PROVIDER_ERROR") })
    const run = await runExtraction(b.projectId, b.userId, b.importId)
    expect(bad.diagram).toBe(1)
    expect(run.doc.paused).toBeNull()
    expect((await draftOf(b.importId)).diagram_images.map((i) => i.kind)).toEqual(["failed"])
  })
})

describe("FLF-360 — đọc lại lô chữ trong lượt import", () => {
  it("lô chữ quá tải rồi đọc được ⇒ không paused, dữ liệu lô đó có trong draft", async () => {
    const { projectId, userId, importId } = await importAtExtracting()
    const count = scripted({ section: "fixed:2.2.1", text: (n) => (n <= 2 ? overloaded() : null) })
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused).toBeNull()
    expect(run.doc.status).toBe("baselining")
    expect(count.text).toBe(3)
    expect((await draftOf(importId)).fields.some((f) => f.path.startsWith("use_cases[") && f.value === "Log in")).toBe(true)
  })

  it("hết lượt đọc lại ⇒ resume_later (không bỏ qua lô chữ); chạy tiếp bắt đầu ở đúng lô hỏng", async () => {
    const { projectId, userId, importId } = await importAtExtracting()
    let down = true
    const count = scripted({ section: "fixed:2.2.1", text: () => (down ? overloaded() : null) })
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused?.reason).toBe("resume_later")
    expect(run.doc.extract_cursor).toBe("fixed:2.2.1")
    expect(count.text).toBe(4)
    // Mục trước đã xong vẫn giữ (không trích lại)
    expect((await draftOf(importId, "fixed:1")).status).toBe("done")
    expect((await draftOf(importId)).status).toBe("failed")
    down = false
    const again = await runExtraction(projectId, userId, importId)
    expect(again.doc.paused).toBeNull()
    expect(again.doc.status).toBe("baselining")
    expect(count.text).toBe(5)
  })
})

describe("FLF-360 — job nền đọc lại ảnh sau bản 0.1", () => {
  it("đọc được ⇒ Spine có dữ liệu, cờ đóng, ảnh gắn sơ đồ gốc, đoạn vẫn in nguyên văn, không thêm cuối mục, không version mới", async () => {
    const { projectId, userId, importId } = await importAtExtracting(USECASE_IMAGE)
    scripted({ diagram: () => overloaded() })
    await runExtraction(projectId, userId, importId)
    const base = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: base.spine_version })
    const before = (await spineRepository.get(projectId))!
    expect(before.flags.filter((f) => f.rule_id === "import_image_unread" && f.resolved_at === null)).toHaveLength(1)
    expect(before.actors.some((a) => a.name === "Guest")).toBe(false)
    const versions = await DocVersion.countDocuments({ projectId })
    const sectionsBefore = new Map((await getDocument(projectId, "Lumen", { source: "draft" })).sections.map((s) => [s.id, s.blocks]))

    // AI hết quá tải ⇒ job đọc lại được
    mockOverrides.next = fakeMode1
    expect(await runImageReread({ projectId, userId, importId })).toBe("done")

    const spine = (await spineRepository.get(projectId))!
    const guest = spine.actors.find((a) => a.name === "Guest")
    expect(guest).toBeTruthy()
    expect(spine.use_cases.find((u) => u.id === "UC-02")?.actor_ids).toContain(guest!.id)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread" && f.resolved_at === null)).toEqual([])
    const image = spine.custom_sections.flatMap((c) => c.blocks).find((b) => b.kind === "image" && b.image_ref === "word/media/image1.png")!
    expect(image.diagram).toEqual({ kind: "usecase", source_hash: originalDiagramHash(spine, "usecase") })
    expect((await draftOf(importId)).diagram_images.map((i) => i.kind)).toEqual(["usecase"])
    // Không version mới; lô ghi `by: import`
    expect(await DocVersion.countDocuments({ projectId })).toBe(versions)
    expect(spine.spine_version).toBe(before.spine_version + 1)
    // FLF-366: đoạn 2.2.1 ghi loại sơ đồ; đoạn chứa phần tử vừa ghi vẫn in nguyên văn, phần tử mới không bị in thêm ở cuối mục
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const seg = profile.section_segments.find((r) => r.section_id === "fixed:2.2.1")!
    expect(seg.parts.flatMap((p) => (p.kind === "original" ? p.diagrams.map((d) => d.kind) : []))).toEqual(["usecase"])
    const after = new Map((await getDocument(projectId, "Lumen", { source: "draft" })).sections.map((s) => [s.id, s.blocks]))
    for (const id of ["fixed:2.1", "fixed:2.2.1", "fixed:2.2.2"]) expect(after.get(id)).toEqual(sectionsBefore.get(id))
    // PlantUML use case không in (ảnh gốc còn)
    const usecaseIds = new Set(spine.diagrams.filter((d) => d.kind === "usecase").map((d) => d.id))
    const json = JSON.stringify([...after.values()])
    for (const id of usecaseIds) expect(json).not.toContain(`diagram-ref:${id}`)

    // Lượt sau không còn gì để đọc
    expect(await runImageReread({ projectId, userId, importId })).toBe("done")
  })

  it("vẫn quá tải ⇒ retry (giữ cờ, không ghi Spine); hết credit ⇒ stopped, giữ cờ", async () => {
    const { projectId, userId, importId } = await importAtExtracting(USECASE_IMAGE)
    scripted({ diagram: () => overloaded() })
    await runExtraction(projectId, userId, importId)
    const base = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: base.spine_version })
    const before = (await spineRepository.get(projectId))!
    expect(await runImageReread({ projectId, userId, importId })).toBe("retry")
    scripted({ diagram: () => new AiActionError(402, "Insufficient credits", "INSUFFICIENT_CREDIT") })
    expect(await runImageReread({ projectId, userId, importId })).toBe("stopped")
    const spine = (await spineRepository.get(projectId))!
    expect(spine.spine_version).toBe(before.spine_version)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread" && f.resolved_at === null)).toHaveLength(1)
    expect((await draftOf(importId)).diagram_images.map((i) => i.kind)).toEqual(["unavailable"])
  })
})
