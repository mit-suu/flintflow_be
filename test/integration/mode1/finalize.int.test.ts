/**
 * Finalize import (nút 1.9–1.10) ở tầng service trên Mongo thật + provider AI giả — plan §8.2 `finalize.test.ts`.
 * FLF-172 P4: một txn `by: import`; steps / luật "step chưa accept" không bắn cờ; `FieldAnchor`; `DocVersion 0.0`;
 * baseline `type: imported`; lỗi giữa chừng không để file mồ côi.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining, importFinalized } from "../../helpers/mode1-import-p4.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { FieldAnchor } from "../../../src/modules/import/field-anchor.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { createMemoryDocFileStore, docFileStore, setDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocxPackage, blockIdOfBookmark, readBlocks, readStamp } from "../../../src/modules/docx-ooxml/index.js"
import { Baseline } from "../../../src/modules/spine/baseline.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import { downloadVersion, toVersionDto } from "../../../src/modules/doc-version/versions.service.js"
import { SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const DATA_ROOTS = /^(project|actors|roles|use_cases|features|screens|permissions|entities|functions|nfrs|business_rules|common_requirements|messages|other_requirements|glossary)\b/

describe("finalize — Spine", () => {
  it("mọi field đã xác nhận ghi trong MỘT transaction by import, lý do có tên file", async () => {
    const { projectId, result, baseVersionBefore } = await importFinalized()
    const changes = await spineRepository.listChanges(projectId)
    const data = changes.filter((c) => DATA_ROOTS.test(c.path))
    expect(data.length).toBeGreaterThan(10)
    expect(new Set(data.map((c) => c.txn)).size).toBe(1)
    expect(new Set(data.map((c) => c.by))).toEqual(new Set(["import"]))
    expect(data[0].reason).toContain("SRS_Lumen.docx")
    // lô dữ liệu là lô đầu tiên sau Spine rỗng; mọi change khác (baseline, cờ) cũng mang by import
    expect(Math.min(...data.map((c) => c.seq))).toBe(Math.min(...changes.map((c) => c.seq)))
    expect(new Set(changes.map((c) => c.by))).toEqual(new Set(["import"]))
    expect(result.spine_version).toBeGreaterThan(baseVersionBefore)
  })

  it("kế hoạch step (FLF-183): steps[] seed theo template; không cờ stale/awaiting — step accepted có last_seq của lô import", async () => {
    const { projectId } = await importFinalized()
    const spine = (await spineRepository.get(projectId))!
    // Mode 1 v2: step sở hữu section có nội dung ⇒ accepted; đầu mục FPT thiếu ⇒ pending; Brief ⇒ skipped
    const status = (id: string) => spine.steps.find((s) => s.id === id)?.status
    expect(status("B-0.1")).toBe("skipped")
    expect(status("S-1.1")).toBe("skipped")
    expect(status("S-3.1")).toBe("accepted")
    const plan = (await TemplateProfile.findOne({ projectId }).lean())!.step_plan
    const missing = plan.filter((p) => p.state === "applied" && p.missing)
    expect(missing.length).toBeGreaterThan(0)
    for (const p of missing) expect(status(p.step_id), p.step_id).toBe("pending")
    for (const p of plan.filter((x) => x.state === "applied" && !x.missing && x.section_ids.length)) expect(status(p.step_id), p.step_id).toBe("accepted")
    for (const p of plan.filter((x) => x.state === "hidden")) expect(status(p.step_id), p.step_id).toBe("skipped")
    expect(spine.progress.current_step).not.toBeNull()
    expect(status(spine.progress.current_step!)).toBe("pending")
    const stepRules = ["section_stale_at_baseline", "section_awaiting_reaccept", "screen_pending_at_baseline"]
    expect(spine.flags.filter((f) => stepRules.includes(f.rule_id))).toEqual([])
    // màn trích từ tài liệu không ở trạng thái chờ mô tả chi tiết của mode 2
    expect(spine.screens.every((s) => s.detail_status !== "pending")).toBe(true)
  })

  it("chỉ field đã xác nhận / độ tin ≥ 0.7 vào Spine: field bị bỏ ở bước 1.9 không có mặt", async () => {
    const { projectId, importId, userId } = await importAtBaselining()
    // import helper đã confirm_all; tạo lại tình huống: xoá trigger đã xác nhận của FR-3.2.1 khỏi draft
    const { ExtractionDraft } = await import("../../../src/modules/import/extraction-draft.model.js")
    await ExtractionDraft.updateMany({ import_id: importId }, { $pull: { fields: { path: "functions[id=FR-3.2.1].trigger" } } })
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.functions.find((f) => f.id === "FR-3.2.1")?.trigger ?? "").toBe("")
    expect(spine.functions.find((f) => f.id === "FR-3.2.2")?.trigger).toBe("Learner submits the form")
  })
})

describe("finalize — FieldAnchor, block, profile", () => {
  it("mỗi thực thể (trừ project) có FieldAnchor trỏ vào block có thật của version 0.0", async () => {
    const { projectId } = await importFinalized()
    const spine = (await spineRepository.get(projectId))!
    const anchors = await FieldAnchor.find({ projectId }).lean()
    const paths = new Set(anchors.map((a) => a.entity_path))
    const expected = [
      ...spine.actors.map((a) => `actors[id=${a.id}]`),
      ...spine.use_cases.map((u) => `use_cases[id=${u.id}]`),
      // feature "General" do code tự tạo cho màn mồ côi — không có block nguồn
      ...spine.features.filter((f) => f.name !== "General").map((f) => `features[id=${f.id}]`),
      ...spine.functions.map((f) => `functions[id=${f.id}]`),
      ...spine.nfrs.map((n) => `nfrs[id=${n.id}]`),
      ...spine.business_rules.map((b) => `business_rules[id=${b.id}]`),
      ...spine.screens.map((s) => `screens[id=${s.id}]`)
    ]
    for (const p of expected) expect(paths.has(p), p).toBe(true)
    expect([...paths].some((p) => p.startsWith("project"))).toBe(false)

    const blockIds = new Set((await DocBlock.find({ projectId, doc_version: "0.0" }).select("block_id").lean()).map((b) => b.block_id))
    for (const a of anchors) {
      expect(a.block_ids.length, a.entity_path).toBeGreaterThan(0)
      for (const b of a.block_ids) expect(blockIds.has(b), `${a.entity_path} → ${b}`).toBe(true)
    }
    // bảng UC trích tất định ⇒ neo vào block bảng
    const uc = anchors.find((a) => a.entity_path === "use_cases[id=UC-01]")!
    const ucBlock = await DocBlock.findOne({ projectId, block_id: uc.block_ids[0] }).lean()
    expect(ucBlock?.kind).toBe("table")
  })

  it("section tạm feature/function ⇒ id thật ở profile và block; mention theo tên được quét lại", async () => {
    const { projectId } = await importFinalized()
    const profile = await TemplateProfile.findOne({ projectId }).lean()
    expect(profile!.heading_map.some((h) => /@B\d+/.test(h.section_id))).toBe(false)
    expect(profile!.heading_map.map((h) => h.section_id)).toEqual(expect.arrayContaining(["feature:F-3.2", "function:FR-3.2.1", "function:FR-3.2.2"]))
    expect(await DocBlock.countDocuments({ projectId, section_id: /@B\d+/ })).toBe(0)
    const loginPara = await DocBlock.findOne({ projectId, text: "SCR-01 Login screen lets the learner sign in." }).lean()
    expect(loginPara?.mentions).toEqual(expect.arrayContaining([{ entity: "screen", id: "SCR-01" }, { entity: "actor", id: "A01" }]))
  })
})

describe("finalize — DocVersion 0.0 + baseline imported", () => {
  it("DocVersion 0.0 kind imported: original_ref = bản gốc + stamp + bookmark; file_ref = bản render từ Spine + stamp (FLF-184); trỏ baseline imported", async () => {
    const { projectId, result, userId } = await importFinalized()
    const versions = await DocVersion.find({ projectId }).lean()
    expect(versions).toHaveLength(1)
    const v = versions[0]
    expect(v).toMatchObject({ version: "0.0", kind: "imported", based_on: null, cr_ids: [], baseline_ref: result.baseline.id })
    expect(String(v.created_by)).toBe(userId)
    expect(v.original_ref).toBeTruthy()
    expect(v.original_ref).not.toBe(v.file_ref)

    const original = await DocxPackage.load(await docFileStore().load(v.original_ref!))
    expect(await readStamp(original)).toEqual({ project_id: projectId, version: "0.0", source: "import" })
    const fileBlocks = await readBlocks(original)
    const stored = await DocBlock.find({ projectId, doc_version: "0.0" }).sort({ "anchor.ordinal": 1 }).lean()
    expect(fileBlocks.map((b) => b.text)).toEqual(stored.map((b) => b.text))
    for (const b of fileBlocks.filter((x) => x.bookmark)) expect(stored.some((s) => s.block_id === blockIdOfBookmark(b.bookmark))).toBe(true)

    const rendered = await DocxPackage.load(await docFileStore().load(v.file_ref))
    expect(await readStamp(rendered)).toEqual({ project_id: projectId, version: "0.0", source: "import" })
    const texts = (await readBlocks(rendered)).map((b) => b.text)
    // Bản render mang nội dung Spine (không phải bản sao file gốc), tiêu đề theo file người dùng
    expect(texts).toContain("1 Product Overview")
    expect(texts).toContain(SRS_FIXTURE_TEXT.purpose)
    expect(texts.some((t) => t.endsWith("Team Notes"))).toBe(true)
  })

  it("tải 0.0: mặc định bản render + DRAFT; variant=original ⇒ file gốc (tên _original); version không có file gốc ⇒ 404", async () => {
    const { projectId } = await importFinalized()
    const v = (await DocVersion.findOne({ projectId, version: "0.0" }).lean())!
    const rendered = await downloadVersion(projectId, "Lumen", "0.0", "auto")
    expect(rendered.filename).toBe(`Lumen_${projectId}_v0.0_DRAFT.docx`) // 6.3: tên file có mã project
    expect((await readBlocks(await DocxPackage.load(rendered.data))).some((b) => b.text === "1 Product Overview")).toBe(true)
    const original = await downloadVersion(projectId, "Lumen", "0.0", "original")
    expect(original.filename).toBe(`Lumen_${projectId}_v0.0_original.docx`)
    expect(original.data.equals(await docFileStore().load(v.original_ref!))).toBe(true)
    expect(toVersionDto(v as never)).toMatchObject({ version: "0.0", has_original_file: true })
    await DocVersion.updateOne({ _id: v._id }, { $set: { original_ref: null } })
    await expect(downloadVersion(projectId, "Lumen", "0.0", "original")).rejects.toMatchObject({ code: "DOC_VERSION_NOT_FOUND" })
  })

  it("DoD V2: bản làm việc ghép sẵn theo layout — thứ tự + tiêu đề như file gốc, mục FPT thiếu chèn cạnh nhóm, mục ngoài FPT giữ nguyên văn", async () => {
    const { projectId } = await importFinalized()
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    const layout = (await TemplateProfile.findOne({ projectId }).lean())!.layout.filter((l) => l.heading_text)
    const strip = (t: string) => t.replace(/^[\d.]+\s+/, "")
    const layoutIds = new Set(layout.map((l) => l.section_id))
    // Mục của file: đúng thứ tự, đúng tiêu đề gốc (bỏ số gõ tay), số đánh lại theo cấp
    expect(doc.sections.filter((s) => layoutIds.has(s.id)).map((s) => s.heading)).toEqual(layout.map((l) => strip(l.heading_text)))
    const byId = new Map(doc.sections.map((s) => [s.id, s]))
    expect(byId.get("fixed:1")).toMatchObject({ number: "1", heading: "Product Overview", level: 1 })
    expect(byId.get("fixed:4.2.3")).toMatchObject({ number: "4.2.3", heading: "Performance" })
    // External Interfaces (thiếu, nhóm "4" chưa có mục FPT nào) ⇒ mục con đầu tiên của heading nhóm "4 Non-Functional Requirements"
    expect(byId.get("fixed:4.1")).toMatchObject({ number: "4.1", level: 2 })
    // Screens Flow (thiếu) đứng ngay trước Screen Descriptions, cùng cấp
    const ids = doc.sections.map((s) => s.id)
    expect(ids.indexOf("fixed:3.1.1")).toBe(ids.indexOf("fixed:3.1.2") - 1)
    expect(byId.get("fixed:3.1.1")).toMatchObject({ number: "3.1.1", heading: "Screens Flow", level: 3 })
    // Mục riêng "5.9 Team Notes" ⇒ custom, nội dung nguyên văn
    const notes = doc.sections.find((s) => s.heading === "Team Notes")!
    expect(notes.id).toMatch(/^custom:/)
    expect(notes.blocks).toEqual([{ type: "paragraph", runs: [{ text: "Internal notes that do not belong to the template." }] }])
    expect(doc.watermark).toBe("DRAFT")
  })

  it("FLF-184: văn xuôi I-4 báo không trích được ⇒ giữ nguyên văn ở đầu section chủ khi render từ Spine", async () => {
    mockOverrides.next = (prompt: string) => {
      const out = fakeMode1(prompt)
      if (out === undefined || !prompt.includes("# Import Extract") || !prompt.includes("Section (registry id): fixed:2.2.1")) return out
      const id = /\[(B\d{4,})\] The diagram shows/.exec(prompt)?.[1]
      return JSON.stringify({ ...(JSON.parse(out) as object), unmapped_block_ids: id ? [id] : [] })
    }
    const { projectId } = await importFinalized()
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    const diagram = doc.sections.find((s) => s.id === "fixed:2.2.1")!
    expect(diagram.blocks[0]).toEqual({ type: "paragraph", runs: [{ text: "The diagram shows UC-01 and UC-02." }] })
  })

  it("baseline type imported, doc_version 0.0, có snapshot Spine; import sang gap_review", async () => {
    const { projectId, result, importId } = await importFinalized()
    expect(result.baseline).toMatchObject({ version: "0.0", type: "imported", doc_version: "0.0" })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.baselines).toHaveLength(1)
    expect(spine.baselines[0]).toMatchObject({ id: result.baseline.id, type: "imported", doc_version: "0.0" })
    const snap = await Baseline.findById(spine.baselines[0].snapshot_ref).lean()
    expect(snap).toMatchObject({ type: "imported", doc_version: "0.0" })
    expect((snap as unknown as { snapshot: { actors: unknown[] } }).snapshot.actors).toHaveLength(2)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("gap_review")
    expect((await Project.findById(projectId).lean())?.import_state).toBe("gap_review")
  })
})

describe("finalize — lỗi", () => {
  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT, không tạo gì", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    await expect(finalizeImport(projectId, userId, { import_id: importId, base_version: 999 })).rejects.toMatchObject({ statusCode: 409 })
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("baselining")
  })

  it("chưa ở baselining (còn fields_review) ⇒ IMPORT_INVALID_STATE", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    await ImportedDocument.updateOne({ _id: importId }, { $set: { status: "fields_review" } })
    const v = (await spineRepository.get(projectId))!.spine_version
    await expect(finalizeImport(projectId, userId, { import_id: importId, base_version: v })).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
  })

  it("Spine đổi giữa lúc ghi file và áp lô ⇒ lô bị từ chối, file 0.0 đã lưu bị xoá (không mồ côi), chạy lại được", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    const memory = createMemoryDocFileStore()
    const real = docFileStore()
    const saved: string[] = []
    // store bọc: ghi file thật vào bộ nhớ rồi "phiên khác" sửa Spine ngay sau đó
    const restore = setDocFileStore({
      ...memory,
      load: (ref) => real.load(ref),
      async save(data, meta) {
        const ref = await memory.save(data, meta)
        saved.push(ref)
        await Spine.updateOne({ projectId: new mongoose.Types.ObjectId(projectId) }, { $inc: { spine_version: 1 } })
        return ref
      }
    })
    try {
      const v = (await spineRepository.get(projectId))!.spine_version
      await expect(finalizeImport(projectId, userId, { import_id: importId, base_version: v })).rejects.toMatchObject({ statusCode: 409 })
      expect(saved).toHaveLength(1)
      expect(memory.files.has(saved[0])).toBe(false)
    } finally {
      restore()
    }
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect(await FieldAnchor.countDocuments({ projectId })).toBe(0)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("baselining")

    // chạy lại với version mới ⇒ thành công
    const v2 = (await spineRepository.get(projectId))!.spine_version
    const again = await finalizeImport(projectId, userId, { import_id: importId, base_version: v2 })
    expect(again.baseline.type).toBe("imported")
  })
})
