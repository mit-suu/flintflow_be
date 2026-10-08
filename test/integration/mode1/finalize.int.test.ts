/**
 * Finalize import (nút 1.9–1.10) ở tầng service trên Mongo thật + provider AI giả — plan §8.2 `finalize.test.ts`.
 * FLF-172 P4: một txn `by: import`; steps / luật "step chưa accept" không bắn cờ; `FieldAnchor`; `DocVersion 0.0`;
 * baseline `type: imported`; lỗi giữa chừng không để file mồ côi.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import { mockImages, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining, importAtExtracting, importFinalized } from "../../helpers/mode1-import-p4.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { AiActionError } from "../../../src/shared/ai/ai-action.types.js"
import { patchFields, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { extractionSummary } from "../../../src/modules/import/import.service.js"
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
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import { originalDiagramHash } from "../../../src/modules/spine/original-diagram.js"
import { assemble, getDocument } from "../../../src/modules/render/assemble.service.js"
import { downloadVersion, toVersionDto } from "../../../src/modules/doc-version/versions.service.js"
import { SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { clearImportMediaCache } from "../../../src/modules/render/import-media.js"

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

  it("FLF-251: Record of Changes có ô tiêu đề xuống dòng (A*⏎M, D) ⇒ đọc đủ dòng từ ô thật, in lên đầu bảng §I của bản render", async () => {
    const recordOfChanges = [
      ["Date", "A*\nM, D", "In charge", "Change Description"],
      ["29/07/2026", "A", "QuynhTTN", "Added User Requirements section"],
      ["17/08/2026", "M", "HiepTT", "Modified use case descriptions\nand actors"]
    ]
    const { projectId } = await importFinalized({ srs: { recordOfChanges } })
    // DocBlock bảng lưu ô như parser đọc — không phải tách lại text
    const table = await DocBlock.findOne({ projectId, kind: "table" }).sort({ "anchor.ordinal": 1 }).lean()
    expect(table!.rows![0]).toEqual(["Date", "A*\nM, D", "In charge", "Change Description"])
    const legacy = (await TemplateProfile.findOne({ projectId }).lean())!.legacy_record_of_changes
    expect(legacy.map((r) => [r.date, r.change_type, r.in_charge, r.description])).toEqual([
      ["29/07/2026", "A", "QuynhTTN", "Added User Requirements section"],
      ["17/08/2026", "M", "HiepTT", "Modified use case descriptions\nand actors"]
    ])
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(doc.recordOfChanges.slice(0, 2).map((r) => r.in_charge)).toEqual(["QuynhTTN", "HiepTT"])
  })

  it("FLF-252: dòng Record of Changes người dùng sửa ở wizard (gửi kèm finalize) thắng dòng đọc từ file", async () => {
    const ctx = await importAtBaselining({ srs: { recordOfChanges: [["Date", "In charge", "Change Description"], ["01/05/2026", "An", "Bản đầu"]] } })
    const before = (await spineRepository.get(ctx.projectId))!
    const edited = [
      { date: "01/05/2026", version: "0.1", change_type: "A" as const, in_charge: "An", description: "Bản đầu (đã sửa)" },
      { date: "02/05/2026", version: "0.2", change_type: "M" as const, in_charge: "Bình", description: "Thêm dòng tay" }
    ]
    await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version, record_of_changes: edited })
    expect((await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!.legacy_record_of_changes).toEqual(edited)
  })

  it("FLF-252: chức năng đọc từ bảng Non-Screen Functions được ghi lại ⇒ bản in: bảng 3.1.4 đúng các dòng đó, không chèn mục 3.x.y cho chúng", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    const doc = (await ImportedDocument.findById(importId))!
    const row = (path: string, value: unknown) => ({ path, value, confidence: 1, source_block_ids: [] as string[], origin: "deterministic" as const, confirmed: true })
    await ExtractionDraft.create({
      projectId: doc.projectId,
      import_id: doc._id,
      section_id: "fixed:3.1.4",
      status: "done",
      fields: [row("functions[id=FR-90].name", "Nightly Sync Job"), row("functions[id=FR-90].description", "Syncs repositories every night.")],
      ops: []
    })
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })

    expect((await TemplateProfile.findOne({ projectId }).lean())!.non_screen_table).toEqual(["FR-90"])
    const rendered = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(rendered.sections.some((s) => s.id === "function:FR-90")).toBe(false)
    const table = rendered.sections.find((s) => s.id === "fixed:3.1.4")!.blocks.find((b) => b.type === "table") as { header: { text: string }[][]; rows: { text: string }[][][] }
    expect(table.header.map((c) => c.map((r) => r.text).join(""))).toEqual(["#", "Feature", "System Function", "Description"])
    expect(table.rows.map((r) => r.map((c) => c.map((x) => x.text).join(""))[2])).toEqual(["Nightly Sync Job"])
  })

  it("FLF-252: mục chức năng in theo file gốc — chưa sửa ⇒ đúng nguyên văn file; change request sửa chức năng ⇒ in từ Spine", async () => {
    const { projectId } = await importFinalized()
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const login = profile.function_originals.find((o) => o.section_id === "function:FR-3.2.2")!
    expect(login.blocks).toEqual([
      { kind: "paragraph", text: SRS_FIXTURE_TEXT.loginNormal, rows: null, image_ref: null },
      { kind: "list_item", text: "Show an error when the password is wrong.", rows: null, image_ref: null }
    ])
    const sectionOf = async () => (await getDocument(projectId, "Lumen", { source: "draft" })).sections.find((s) => s.id === "function:FR-3.2.2")!
    expect((await sectionOf()).blocks).toEqual([
      { type: "paragraph", runs: [{ text: SRS_FIXTURE_TEXT.loginNormal }] },
      { type: "bullet_list", items: [[{ text: "Show an error when the password is wrong." }]] }
    ])

    // sửa chức năng (như một change request ghi vào Spine) ⇒ dấu nội dung lệch ⇒ in từ Spine
    const spine = (await spineRepository.get(projectId))!
    const applied = await applyTransaction(projectId, {
      base_version: spine.spine_version,
      ops: [{ op: "set", path: "functions[id=FR-3.2.2].trigger", value: "Learner clicks Sign in" }],
      by: "import",
      reason: "test",
      step_id: null
    })
    // luồng change request ghép lại bản làm việc sau khi ghi Spine
    await assemble(projectId, "Lumen", applied.spine_version)
    expect(JSON.stringify((await sectionOf()).blocks)).toContain("Learner clicks Sign in")
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

describe("ảnh — giữ ảnh gốc (T3) + đọc ảnh diagram (mode 1 v3 phase 5)", () => {
  const PNG = buildPlaceholderPng(12, 7, 0x40)
  const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0, 0, 0, 0])
  const srs = { images: [{ name: "image1.png", data: PNG }, { name: "image2.emf", data: EMF }] }

  beforeEach(() => clearImportMediaCache())

  it("ảnh dưới mục FPT ⇒ block image_ref ⇒ phần nối nguyên văn của mục; bản render 0.0 nhúng lại đúng bytes PNG, EMF ⇒ chỗ giữ ảnh có lý do", async () => {
    const { projectId } = await importFinalized({ srs })
    const blocks = await DocBlock.find({ projectId, doc_version: "0.0", kind: "image" }).lean()
    expect(blocks.map((b) => b.image_ref).sort()).toEqual(["word/media/image1.png", "word/media/image2.emf"])

    const spine = (await spineRepository.get(projectId))!
    const refs = spine.custom_sections.flatMap((c) => c.blocks.filter((b) => b.kind === "image").map((b) => b.image_ref))
    expect(refs.sort()).toEqual(["word/media/image1.png", "word/media/image2.emf"])

    const v = (await DocVersion.findOne({ projectId, version: "0.0" }).lean())!
    const rendered = await DocxPackage.load(await docFileStore().load(v.file_ref))
    const media = await Promise.all(
      rendered.partNames().filter((n) => n.startsWith("word/media/")).map(async (n) => (await rendered.binary(n))!)
    )
    expect(media.some((m) => m.equals(PNG))).toBe(true)
    const texts = (await readBlocks(rendered)).map((b) => b.text)
    expect(texts.some((t) => t.includes("original image could not be embedded (unsupported format)"))).toBe(true)
    // không in đường dẫn file ảnh trong tài liệu
    expect(texts.some((t) => t.includes("word/media/"))).toBe(false)

    // I-4: PNG gửi Gemini (mock trả `other`), EMF không gửi ⇒ cả hai giữ ảnh gốc + cờ vàng "không đọc được"
    expect(mockImages.flat()).toEqual([{ mime: "image/png", bytes: PNG.length }])
    const imageFlags = spine.flags.filter((f) => f.rule_id === "import_image_unread")
    expect(imageFlags.map((f) => [f.level, f.section_id])).toEqual([
      ["yellow", "fixed:2.2.1"],
      ["yellow", "fixed:2.2.1"]
    ])
    // câu cho người đọc: nêu mục theo tiêu đề, không in tên file ảnh / block id / tiền tố [image]
    const imageText = imageFlags.map((f) => f.message).join("\n")
    expect(imageText).toContain("định dạng ảnh không hỗ trợ")
    expect(imageText).toContain('trong mục "')
    expect(imageText).not.toMatch(/word\/media|\[image\]|B\d{4}/)
  })

  it("I-4 đọc ảnh use case: origin vision, độ tin ≤ 0.7 ⇒ luôn qua 1.9; lượt gọi có ảnh + chú thích", async () => {
    const { projectId, userId, importId } = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] } })
    const prompts: string[] = []
    mockOverrides.next = (prompt) => {
      prompts.push(prompt)
      return fakeMode1(prompt)
    }
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.status).toBe("fields_review")
    const draft = (await ExtractionDraft.findOne({ import_id: importId, section_id: "fixed:2.2.1" }).lean())!
    expect(draft.diagram_images).toEqual([{ block_id: expect.stringMatching(/^B\d+$/), kind: "usecase" }])
    const guest = draft.fields.filter((f) => f.origin === "vision")
    expect(guest.length).toBeGreaterThan(0)
    for (const f of guest) expect(f.confidence).toBeLessThanOrEqual(0.7)
    // actor Guest (0.95 từ model) bị hạ trần 0.7 nhưng vẫn phải xác nhận
    expect(guest.some((f) => f.path.startsWith("actors[") && f.value === "Guest" && f.confidence === 0.7)).toBe(true)
    const view = await extractionSummary(importId)
    expect(view.review_fields.some((f) => f.origin === "vision" && f.value === "Guest")).toBe(true)
    const visionPrompt = prompts.find((p) => p.includes("# Read Diagram Image"))!
    expect(visionPrompt).toContain("Figure 1 USECASE-IMG")
    expect(visionPrompt).toContain("Section (registry id): fixed:2.2.1")
    expect(mockImages.flat()).toEqual([{ mime: "image/png", bytes: PNG.length }])
  })

  it("FLF-252: sơ đồ đọc trước bảng use case, ảnh không ghi mã ⇒ ghép theo tên với bảng phía sau, không cấp mã mới / trùng, phần trùng không phải duyệt", async () => {
    const { projectId, userId, importId } = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] } })
    mockOverrides.next = (prompt: string) => {
      if (!prompt.includes("# Read Diagram Image")) return fakeMode1(prompt)
      const b = /Image block: \[(B\d{4,})\]/.exec(prompt)?.[1]
      const uc = (name: string, actor_ids: string[]) => ({ entity: "use_cases", key: null, value: { name, actor_ids }, confidence: 0.7, field_confidence: {}, source_block_ids: [b] })
      return JSON.stringify({ section_id: "fixed:2.2.1", diagram_kind: "usecase", items: [uc("register account", ["Learner"]), uc("Log In", ["Learner"])], unmapped_block_ids: [] })
    }
    await runExtraction(projectId, userId, importId)
    const drafts = await ExtractionDraft.find({ import_id: importId }).lean()
    const ucIds = new Set(drafts.flatMap((d) => d.fields).flatMap((f) => /^use_cases\[id=([^\]]+)\]/.exec(f.path)?.[1] ?? []))
    // trước đây ảnh không mã được cấp UC-01, UC-02… rồi gộp nhầm với UC của bảng; nay ghép theo tên ⇒ chỉ còn mã của bảng
    expect([...ucIds].sort()).toEqual(["UC-01", "UC-02"])
    const review = await extractionSummary(importId)
    expect(review.review_fields.filter((f) => f.origin === "vision" && f.path.startsWith("use_cases["))).toEqual([])
  })

  it("FLF-252: sơ đồ ngữ cảnh + sơ đồ use case vẽ lại tác nhân của bảng, model chép khoá 'A01' ⇒ Spine không nhân đôi tác nhân, phần ảnh thêm vào chỉ hỏi một lần", async () => {
    const { projectId, userId, importId } = await importAtExtracting({
      srs: {
        images: [
          { name: "image1.png", data: PNG, caption: "Figure 1 CONTEXT-IMG" },
          { name: "image2.png", data: PNG, caption: "Figure 2 USECASE-IMG" }
        ]
      }
    })
    const visionPrompts: string[] = []
    mockOverrides.next = (prompt: string) => {
      if (!prompt.includes("# Read Diagram Image")) return fakeMode1(prompt)
      visionPrompts.push(prompt)
      const b = /Image block: \[(B\d{4,})\]/.exec(prompt)?.[1]
      // model dùng lại khoá của known_keys đúng như được đưa: "A01 (Learner)"
      const keyOf = (name: string) => new RegExp(`(A\\d+) \\(${name}\\)`).exec(prompt)?.[1] ?? null
      const item = (entity: string, key: string | null, value: object) => ({ entity, key, value, confidence: 0.7, field_confidence: {}, source_block_ids: [b] })
      const actors = [
        item("actors", keyOf("Learner"), { name: "Learner", kind: "human" }),
        item("actors", keyOf("Admin"), { name: "Admin", kind: "human" }),
        item("actors", keyOf("Email Service"), { name: "Email Service", kind: "system" })
      ]
      if (prompt.includes("CONTEXT-IMG")) return JSON.stringify({ section_id: "fixed:2.2.1", diagram_kind: "context", items: actors, unmapped_block_ids: [] })
      const uc = item("use_cases", "UC-02", { name: "Log in", actor_ids: [keyOf("Learner"), "Email Service"] })
      return JSON.stringify({ section_id: "fixed:2.2.1", diagram_kind: "usecase", items: [...actors, uc], unmapped_block_ids: [] })
    }
    await runExtraction(projectId, userId, importId)
    expect(visionPrompts).toHaveLength(2)
    expect(visionPrompts[0]).toContain("A01 (Learner)")

    // trước đây "A01" chuẩn hoá thành "A-01" ⇒ mỗi ảnh thêm một bản Learner / Admin
    const fields = (await ExtractionDraft.find({ import_id: importId }).lean()).flatMap((d) => d.fields)
    const actorIds = new Set(fields.flatMap((f) => /^actors\[id=([^\]]+)\]/.exec(f.path)?.[1] ?? []))
    expect([...actorIds].sort()).toEqual(["A01", "A02", "A03"])
    // ảnh chỉ thêm: loại tác nhân bảng không ghi, tác nhân mới, quan hệ mới — mỗi thứ một dòng duyệt, kể cả quan hệ gộp
    // vào use case chữ cùng mục cũng nói tới
    const fromImages = fields.filter((f) => f.origin === "vision").map((f) => `${f.path}=${JSON.stringify(f.value)}`)
    expect(fromImages.sort()).toEqual(
      [
        'actors[id=A01].kind="human"',
        'actors[id=A02].kind="human"',
        'actors[id=A03].name="Email Service"',
        'actors[id=A03].kind="system"',
        'use_cases[id=UC-02].actor_ids=["Learner","Email Service"]'
      ].sort()
    )
    expect(fields.filter((f) => f.origin === "vision").every((f) => f.confidence <= 0.7)).toBe(true)

    await patchFields(projectId, { import_id: importId, fields: [], confirm_all: true })
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.map((a) => `${a.name}:${a.kind}`).sort()).toEqual(["Admin:human", "Email Service:system", "Learner:human"])
    expect([...(spine.use_cases.find((u) => u.id === "UC-02")?.actor_ids ?? [])].sort()).toEqual(["A01", "A03"])
  })

  it("diagram đọc được ⇒ Spine có actor + quan hệ từ ảnh (hợp với bảng), hình gốc giữ y trong bản render + đánh dấu sơ đồ gốc (§4.13), không cờ ảnh", async () => {
    mockOverrides.next = fakeMode1
    const { projectId } = await importFinalized({ srs: { images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] } })
    const spine = (await spineRepository.get(projectId))!
    const guest = spine.actors.find((a) => a.name === "Guest")!
    const learner = spine.actors.find((a) => a.name === "Learner")!
    expect(guest).toBeTruthy()
    // sắp xếp trên bản sao — `sort()` tại chỗ đổi thứ tự trong `spine` rồi làm hash sơ đồ tính bên dưới lệch
    expect([...(spine.use_cases.find((u) => u.id === "UC-02")?.actor_ids ?? [])].sort()).toEqual([guest.id, learner.id].sort())
    // Hình của người dùng giữ nguyên, đánh dấu loại + hash dữ liệu lúc import (đúng dữ liệu vừa đọc từ ảnh)
    const images = spine.custom_sections.flatMap((c) => c.blocks).filter((b) => b.kind === "image")
    expect(images).toEqual([expect.objectContaining({ image_ref: "word/media/image1.png", diagram: { kind: "usecase", source_hash: originalDiagramHash(spine, "usecase") } })])
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread" || f.rule_id === "original_diagram_stale")).toEqual([])
    const v = (await DocVersion.findOne({ projectId, version: "0.0" }).lean())!
    const rendered = await DocxPackage.load(await docFileStore().load(v.file_ref))
    const media = await Promise.all(rendered.partNames().filter((n) => n.startsWith("word/media/")).map(async (n) => (await rendered.binary(n))!))
    expect(media.some((m) => m.equals(PNG))).toBe(true)
  })

  it("môi trường không có vision (thiếu GEMINI_API_KEY) ⇒ I-4 không dừng: ảnh unsupported, giữ ảnh gốc + cờ vàng", async () => {
    mockOverrides.next = (prompt) =>
      prompt.includes("# Read Diagram Image") ? new AiActionError(500, "Gemini API key is missing.", "GEMINI_KEY_MISSING") : fakeMode1(prompt)
    const { projectId, importId } = await importFinalized({ srs: { images: [{ name: "image1.png", data: PNG, caption: "USECASE-IMG" }] } })
    const draft = (await ExtractionDraft.findOne({ import_id: importId, section_id: "fixed:2.2.1" }).lean())!
    expect(draft.diagram_images.map((i) => i.kind)).toEqual(["unsupported"])
    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.some((a) => a.name === "Guest")).toBe(false)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread")).toHaveLength(1)
    expect(spine.custom_sections.flatMap((c) => c.blocks).some((b) => b.kind === "image" && b.image_ref === "word/media/image1.png")).toBe(true)
  })

  it("hết credit giữa lượt đọc ảnh ⇒ I-4 dừng (paused credits) ở section có ảnh, chạy tiếp được", async () => {
    const { projectId, userId, importId } = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "USECASE-IMG" }] } })
    let fail = true
    mockOverrides.next = (prompt) => {
      if (fail && prompt.includes("# Read Diagram Image")) return new AiActionError(402, "Insufficient credits", "INSUFFICIENT_CREDIT")
      return fakeMode1(prompt)
    }
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused?.reason).toBe("credits")
    expect(run.doc.extract_cursor).toBe("fixed:2.2.1")
    fail = false
    const again = await runExtraction(projectId, userId, importId)
    expect(again.doc.paused).toBeNull()
    expect(again.doc.status).toBe("fields_review")
  })

  it("đọc ảnh lỗi sau mọi lượt thử (Gemini quá tải cả model dự phòng) ⇒ I-4 không dừng: giữ ảnh gốc + cờ vàng nói rõ lý do", async () => {
    const { projectId, userId, importId } = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "USECASE-IMG" }] } })
    mockOverrides.next = (prompt) =>
      prompt.includes("# Read Diagram Image") ? new AiActionError(503, "high demand (đã thử gemini-3.5-flash, gemini-3.6-flash, gemini-3.5-flash-lite)", "GEMINI_OVERLOADED") : fakeMode1(prompt)
    const run = await runExtraction(projectId, userId, importId)
    expect(run.doc.paused).toBeNull()
    expect(run.doc.status).toBe("fields_review")
    const draft = (await ExtractionDraft.findOne({ import_id: importId, section_id: "fixed:2.2.1" }).lean())!
    expect(draft.diagram_images.map((i) => i.kind)).toEqual(["unavailable"])
  })

  it("FLF-252: ảnh không đọc được + quyền không khớp màn trong cùng lần nhập ⇒ hai cờ vàng khác id, tạo được bản 0.0 (trước đây trùng id ⇒ cả lô bị từ chối)", async () => {
    const { projectId, userId, importId } = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "USECASE-IMG" }] } })
    mockOverrides.next = (prompt) => (prompt.includes("# Read Diagram Image") ? new AiActionError(503, "high demand", "GEMINI_OVERLOADED") : fakeMode1(prompt))
    const run = await runExtraction(projectId, userId, importId)
    // ma trận phân quyền nhắc một màn không có trong bảng mô tả màn (WDP301: "Sell Statistics")
    const field = (path: string, value: unknown) => ({ path, value, confidence: 1, source_block_ids: [] as string[], origin: "deterministic" as const, confirmed: true })
    await ExtractionDraft.updateOne(
      { import_id: importId, section_id: "fixed:2.1" },
      {
        $push: {
          fields: {
            $each: [
              field("roles[id=R01].name", "Admin"),
              field("permissions[id=P001].screen_id", "Sell Statistics"),
              field("permissions[id=P001].role_id", "Admin"),
              field("permissions[id=P001].action", "access")
            ]
          }
        }
      }
    )
    if (run.doc.status === "fields_review") await patchFields(projectId, { import_id: importId, fields: [], confirm_all: true })
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, userId, { import_id: importId, base_version: before.spine_version })

    const spine = (await spineRepository.get(projectId))!
    const flags = spine.flags.filter((f) => f.rule_id === "import_image_unread" || f.rule_id === "import_unresolved_ref")
    expect(flags.map((f) => f.rule_id).sort()).toEqual(["import_image_unread", "import_unresolved_ref"])
    expect(new Set(flags.map((f) => f.id)).size).toBe(2)
    expect(flags.find((f) => f.rule_id === "import_unresolved_ref")!.message).toContain('"Sell Statistics"')
    expect(await DocVersion.countDocuments({ projectId, version: "0.0" })).toBe(1)
  })

  it("file gốc không còn ⇒ render vẫn chạy, ảnh thành chỗ giữ ảnh", async () => {
    const { projectId } = await importFinalized({ srs: { images: [{ name: "image1.png", data: PNG }] } })
    await ImportedDocument.updateMany({ projectId }, { $set: { file_ref: null } })
    clearImportMediaCache()
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(JSON.stringify(doc)).toContain("original image could not be embedded (unsupported format)")
  })
})
