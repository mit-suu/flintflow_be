/**
 * Mode 1 — I-4 trích field, xác nhận field, finalize (baseline v0 + version 0.0), check, gap report, re-upload
 * qua HTTP trên Mongo thật, provider AI giả (FLF-171, P2 2C + 2D).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import JSZip from "jszip"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../helpers/mode1.js"
import { DocxPackage, applyEdit, readBlocks, readStamp, RevisionIds } from "../../src/modules/docx-ooxml/index.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { extractResponseSchema, finalizeResponseSchema, gapReportSchema, getImportResponseSchema, reuploadDiffDtoSchema } from "../../src/modules/import/import.dto.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { DocVersion } from "../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../src/modules/doc-version/doc-file.store.js"
import { DocBlock } from "../../src/modules/import/doc-block.model.js"
import { FieldAnchor } from "../../src/modules/import/field-anchor.model.js"
import { Usage } from "../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const extractCalls = () => mockCalls.filter((c) => c.kind === "other").length

/** Upload + xác nhận ⇒ import ở `extracting`. */
const startImport = async (balance = 1000) => {
  const seeded = await seedFixture("minimal", { balance })
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  const confirmed = await c.post("/import/confirm-latest", { import_id: id })
  expect(confirmed.body.data.import.status).toBe("extracting")
  return { seeded, projectId, c, id }
}

/** Chạy tới gap_review. */
const importToGapReview = async () => {
  const s = await startImport()
  const ex = await s.c.post("/import/extract", { import_id: s.id })
  expect(ex.status, JSON.stringify(ex.body.error)).toBe(200)
  await s.c.patch("/import/fields", { import_id: s.id, confirm_all: true })
  const fin = await s.c.post("/import/finalize", { import_id: s.id, base_version: await s.c.spineVersion() })
  expect(fin.status, JSON.stringify(fin.body.error)).toBe(200)
  return s
}

describe("mode 1 — trích field (I-4) + xác nhận", () => {
  it("bảng khớp cột trích tất định, chữ gọi AI theo section; field độ tin thấp ⇒ fields_review", async () => {
    const { c, id, projectId } = await startImport()
    const res = await c.post("/import/extract", { import_id: id })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const run = extractResponseSchema.parse(res.body.data)
    expect(run.import.status).toBe("fields_review")
    expect(run.import.extract_cursor).toBeNull()
    expect(run.sections.every((s) => s.status === "done")).toBe(true)
    // 6 section có chữ ⇒ 6 lượt AI; bảng actor/UC/BR không gọi AI
    expect(extractCalls()).toBe(6)
    const steps = await Usage.find({ projectId, state: "deducted" }).distinct("step_id")
    expect(steps).toContain("I-4:fixed:1")
    expect(steps.some((s: string) => s.startsWith("I-4:function:@B"))).toBe(true)

    const view = getImportResponseSchema.parse((await c.get("/import")).body.data)
    const actors = view.extraction.sections.find((s) => s.section_id === "fixed:2.1")!
    expect(actors.fields_total).toBeGreaterThanOrEqual(4)
    // trigger độ tin 0.5 của 2 function ⇒ cần xác nhận
    expect(view.extraction.review_fields.map((f) => f.path).sort()).toEqual(["functions[id=FR-3.2.1].trigger", "functions[id=FR-3.2.2].trigger"])

    const reject = view.extraction.review_fields[0]
    const patched = await c.patch("/import/fields", { import_id: id, fields: [{ section_id: reject.section_id, path: reject.path, confirmed: false }] })
    expect(patched.body.data.import.status).toBe("fields_review")
    const edit = view.extraction.review_fields[1]
    const done = await c.patch("/import/fields", {
      import_id: id,
      fields: [{ section_id: edit.section_id, path: edit.path, confirmed: true, edited_value: "Learner clicks Log in" }]
    })
    expect(done.body.data.import.status).toBe("baselining")
  })

  it("hết credit giữa I-4 ⇒ paused, nạp xong resume không trích lại section đã xong", async () => {
    const { c, id, seeded } = await startImport(5)
    const first = extractResponseSchema.parse((await c.post("/import/extract", { import_id: id })).body.data)
    expect(first.import.status).toBe("extracting")
    expect(first.import.paused?.reason).toBe("credits")
    expect(first.import.extract_cursor).not.toBeNull()
    const doneBefore = first.sections.filter((s) => s.status === "done").map((s) => s.section_id)
    expect(extractCalls()).toBe(2)
    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet).toMatchObject({ balance: 1, reserved: 0 })

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 1000 } })
    const resumed = extractResponseSchema.parse((await c.post("/import/resume", { import_id: id })).body.data)
    expect(resumed.import.paused).toBeNull()
    expect(resumed.import.status).toBe("fields_review")
    expect(extractCalls()).toBe(6)
    const prompts = mockCalls.slice(2)
    expect(prompts).toHaveLength(4)
    for (const s of doneBefore) expect(resumed.sections.find((x) => x.section_id === s)?.status).toBe("done")
  })

  it("AI lỗi sau retry ⇒ paused resume_later, hold được hoàn", async () => {
    const { c, id, seeded } = await startImport()
    mockOverrides.next = (prompt) => (prompt.includes("# Import Extract") ? new Error("provider down") : undefined)
    const res = extractResponseSchema.parse((await c.post("/import/extract", { import_id: id })).body.data)
    expect(res.import.paused?.reason).toBe("resume_later")
    expect(res.sections.some((s) => s.status === "failed" && s.error)).toBe(true)
    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet).toMatchObject({ balance: 1000, reserved: 0 })
  }, 30_000)
})

describe("mode 1 — finalize, check, gap report", () => {
  it("finalize: Spine một txn by import, version 0.0 có stamp + bookmark, baseline imported, cờ AI vàng, gap report", async () => {
    const { c, id, projectId } = await startImport()
    await c.post("/import/extract", { import_id: id })
    await c.patch("/import/fields", { import_id: id, confirm_all: true })

    const conflict = await c.post("/import/finalize", { import_id: id, base_version: 999 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("SPINE_VERSION_CONFLICT")

    const res = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const fin = finalizeResponseSchema.parse(res.body.data)
    expect(fin.import.status).toBe("gap_review")
    expect(fin.baseline).toMatchObject({ version: "0.0", type: "imported", doc_version: "0.0" })
    expect(fin.flags.yellow).toBeGreaterThanOrEqual(1)

    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.map((a) => a.name)).toEqual(["Learner", "Admin"])
    expect(spine.use_cases.find((u) => u.id === "UC-01")).toMatchObject({ name: "Register account", actor_ids: ["A01"] })
    expect(spine.use_cases.find((u) => u.id === "UC-02")?.actor_ids).toEqual(["A01"])
    expect(spine.features.map((f) => [f.id, f.name])).toContainEqual(["F-3.2", "Authentication"])
    expect(spine.functions.map((f) => [f.id, f.feature_id])).toEqual([
      ["FR-3.2.1", "F-3.2"],
      ["FR-3.2.2", "F-3.2"]
    ])
    expect(spine.functions[1].normal).toEqual(["Enter email", "Submit"])
    expect(spine.business_rules.map((b) => b.id)).toEqual(["BR-01"])
    expect(spine.nfrs[0]).toMatchObject({ id: "NFR-01", category: "performance", kind: "quantitative" })
    expect(spine.project.vision).toContain("Lumen")
    expect(spine.flags.find((f) => f.rule_id === "import_semantic")).toMatchObject({ level: "yellow", section_id: "fixed:4.2.3" })
    // hồ sơ luật mode 1: không còn cờ array_empty / non_english_content
    expect(spine.flags.filter((f) => ["array_empty", "non_english_content"].includes(f.rule_id))).toEqual([])
    const changes = await spineRepository.listChanges(projectId)
    expect(new Set(changes.filter((ch) => ch.by === "import" && ch.path.startsWith("actors")).map((ch) => ch.txn)).size).toBe(1)

    // block: section tạm ⇒ id thật; mention theo tên; FieldAnchor
    const fnBlock = await DocBlock.findOne({ projectId, text: "Learner creates an account with email (UC-01)." }).lean()
    expect(fnBlock?.section_id).toBe("function:FR-3.2.1")
    expect(fnBlock?.mentions).toEqual(expect.arrayContaining([{ entity: "use_case", id: "UC-01" }, { entity: "actor", id: "A01" }]))
    expect((await FieldAnchor.findOne({ projectId, entity_path: "use_cases[id=UC-01]" }).lean())?.block_ids.length).toBeGreaterThan(0)

    // version 0.0: file có stamp + bookmark neo
    const version = await DocVersion.findOne({ projectId, version: "0.0" }).lean()
    expect(version).toMatchObject({ kind: "imported", baseline_ref: fin.baseline.id })
    const pkg = await DocxPackage.load(await docFileStore().load(version!.file_ref))
    expect(await readStamp(pkg)).toEqual({ project_id: projectId, version: "0.0", source: "import" })
    expect((await readBlocks(pkg))[0].bookmark).toBe("_ff_B0001")

    const report = gapReportSchema.parse((await c.get("/gap-report")).body.data)
    expect(report.totals.yellow).toBe(fin.flags.yellow)
    expect(report.unmapped_headings.map((u) => u.text)).toEqual(["5.9 Team Notes"])
    expect(report.missing_sections.map((m) => m.section_id)).toContain("fixed:3.1.1")
    expect(report.low_confidence_fields.length).toBe(2)

    const docx = await c.get("/gap-report?format=docx").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on("data", (d: Buffer) => chunks.push(d))
      res.on("end", () => cb(null, Buffer.concat(chunks)))
    })
    expect(docx.status).toBe(200)
    expect(docx.headers["content-disposition"]).toContain(".docx")
    const zip = await JSZip.loadAsync(docx.body as Buffer)
    expect(await zip.file("word/document.xml")!.async("string")).toContain("Gap report")
    expect(getImportResponseSchema.parse((await c.get("/import")).body.data).import?.status).toBe("delivered")
  })

  it("gap report trước khi check ⇒ IMPORT_INVALID_STATE; upload lại sau baseline ⇒ phải dùng /reupload", async () => {
    const { c } = await startImport()
    expect((await c.get("/gap-report")).body.error.code).toBe("IMPORT_INVALID_STATE")
    const early = await c.upload(await makeSrsDocx(), "x.docx", "/reupload")
    expect(early.status).toBe(409)
  })

  it("AI check hết credit ⇒ paused ở checking; resume ⇒ gap_review", async () => {
    const { c, id, seeded } = await startImport()
    await c.post("/import/extract", { import_id: id })
    await c.patch("/import/fields", { import_id: id, confirm_all: true })
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const fin = finalizeResponseSchema.parse((await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })).body.data)
    expect(fin.import).toMatchObject({ status: "checking", paused: { reason: "credits" } })
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    const resumed = await c.post("/import/resume", { import_id: id })
    expect(resumed.status, JSON.stringify(resumed.body.error)).toBe(200)
    expect(resumed.body.data.import).toMatchObject({ status: "gap_review", paused: null })
  })
})

describe("mode 1 — re-upload (UC-24)", () => {
  it("file sửa ngoài FlintFlow ⇒ diff theo block, không tạo version; /import sau baseline bị chặn", async () => {
    const { c, projectId } = await importToGapReview()
    const version = await DocVersion.findOne({ projectId, version: "0.0" }).lean()
    const pkg = await DocxPackage.load(await docFileStore().load(version!.file_ref))
    const blocks = await readBlocks(pkg)
    const target = blocks.find((b) => b.text.startsWith("The system shall respond"))!
    // người dùng sửa trong Word (không Track Changes): thay text trực tiếp
    const doc = await pkg.requireXml("word/document.xml")
    applyEdit(target.element, target.text, "The system shall respond within 1 second.", { author: "CR-999", date: new Date(), ids: new RevisionIds(doc) })
    const { acceptAll } = await import("../../src/modules/docx-ooxml/index.js")
    await acceptAll(pkg)

    const res = await c.upload(await pkg.toBuffer(), "SRS_Lumen_v2.docx", "/reupload")
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const diff = reuploadDiffDtoSchema.parse(res.body.data)
    expect(diff.against_version).toBe("0.0")
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, moved: 0 })
    expect(diff.blocks[0]).toMatchObject({ block_id: target.bookmark!.slice(4), change: "modified", after: "The system shall respond within 1 second." })
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)

    const blocked = await c.upload(await makeSrsDocx())
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("IMPORT_INVALID_STATE")
  })
})
