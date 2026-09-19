/**
 * C-7 ghi thay đổi đã duyệt (`write.service.ts`, nút 3.14) trên Mongo + GridFS thật. FLF-172, plan §8.3.
 * Ca chính: Track Changes + comment author = CR id; version 0.1 → 0.2; txn Spine có reason; mở khoá hết;
 * lỗi giữa chừng không để file mồ côi và chạy lại được. Thêm: base_version cũ ⇒ 409, text block lệch ⇒ 409,
 * khoá của CR khác được giữ sang version mới.
 * Lỗi giữa chừng giả lập bằng `vi.spyOn` trên model / store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToImpact, crToReady, crToReview, detail, gridFsFiles, importedProject, lockedBlocks, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { DocxPackage, listComments, listRevisions, readBlocks, readStamp, textHash } from "../../../src/modules/docx-ooxml/index.js"
import { docFileStore, gridFsDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ChangeGroup } from "../../../src/modules/change-request/change-group.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

/** C-2: CR có "Rename registration" trong tiêu đề ⇒ đích UC-01 / FR-3.2.2 (không chồng block với CR perf). */
const UC_TARGETS = { entity_paths: ["use_cases[id=UC-01]", "functions[id=FR-3.2.2]"], keywords: ["Register"] }
const route = (p: string) => (p.includes("Rename registration") ? fakeCrClarify(UC_TARGETS)(p) : fakeCrClarify(PERF_TARGETS)(p)) ?? fakeCrPropose(p)

beforeEach(() => resetCrMock(route))
afterEach(() => vi.restoreAllMocks())

const NEW_PERF = "The system shall respond within 1 second for 95% of requests."

const approveAll = async (c: Mode1Client, cr: string, groups: { group_id: string }[]) => {
  let last = null as ReturnType<typeof detail> | null
  for (const g of groups) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
  return last!
}

/** Duyệt mọi group trừ group cuối (để lần quyết cuối mới kích hoạt ghi). */
const approveAllButLast = async (c: Mode1Client, cr: string, groups: { group_id: string }[]) => {
  for (const g of groups.slice(0, -1)) detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
  return groups[groups.length - 1].group_id
}

const loadVersion = async (projectId: string, version: string) => {
  const v = await DocVersion.findOne({ projectId, version }).lean()
  expect(v, `thiếu version ${version}`).not.toBeNull()
  return { v: v!, pkg: await DocxPackage.load(await docFileStore().load(v!.file_ref)) }
}

describe("C-7 ghi Track Changes + comment", () => {
  it("0.0 → 0.1: edit thành w:ins/w:del, comment Word, author = CR id, stamp 0.1; block mới giữ block_id + section", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })

    const { v, pkg } = await loadVersion(projectId, "0.1")
    expect(v).toMatchObject({ kind: "cr_revision", based_on: "0.0", cr_ids: [crId], baseline_ref: null })
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId, version: "0.1", source: "cr_revision" })
    const revs = await listRevisions(pkg)
    expect(new Set(revs.map((r) => r.kind))).toEqual(new Set(["ins", "del"]))
    expect(new Set(revs.map((r) => r.author))).toEqual(new Set([crId]))
    const comments = await listComments(pkg)
    expect(comments.map((x) => x.author)).toEqual([crId, crId])
    expect(comments.map((x) => x.text)).toEqual(['Check "4.2.3 Performance"', 'Check "5.1 Business Rules"'])
    expect((await readBlocks(pkg)).find((b) => b.text.startsWith("The system shall"))?.text).toBe(NEW_PERF)

    const blocks = await DocBlock.find({ projectId, doc_version: "0.1" }).lean()
    expect(blocks.length).toBe(await DocBlock.countDocuments({ projectId, doc_version: "0.0" }))
    const perf = blocks.find((b) => b.block_id === "B0039")!
    expect(perf).toMatchObject({ text: NEW_PERF, text_hash: textHash(NEW_PERF), section_id: "fixed:4.2.3", locked_by_cr: null })
    expect(blocks.find((b) => b.block_id === "B0014")?.mentions.map((m) => m.id).sort()).toEqual(["UC-01", "UC-02"])
  })

  it("txn Spine: op của CR áp với by = CR id, reason = 'CR id: tiêu đề'; mở hết khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const before = await c.spineVersion()
    await approveAll(c, cr, submitted.groups)
    const spine = (await spineRepository.get(projectId))!
    expect(spine.spine_version).toBeGreaterThan(before)
    expect(spine.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("1 s")
    const changes = (await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ value: "1 s", reason: `${crId}: Faster response time` })
    expect(await DocBlock.countDocuments({ projectId, locked_by_cr: crId })).toBe(0)
  })

  it("0.1 → 0.2: CR ghi sau dùng file 0.1 (giữ Track Changes + comment của CR ghi trước); khoá của CR đang mở được giữ sang 0.1", async () => {
    const { c, projectId } = await importedProject()
    // CR-001 (UC-01/FR-3.2.2) khoá block ở 0.0; CR-002 (perf) ghi trước ⇒ 0.1, rồi CR-001 ghi ⇒ 0.2
    const ucCr = await crToImpact(c, "Rename registration", "Rename UC-01 and adjust the login function.")
    const ucBlocks = await lockedBlocks(projectId, ucCr.crId)
    const perfCr = await crToReview(c)
    await approveAll(c, perfCr.cr, perfCr.submitted.groups)
    // version mới mang khoá của CR đang mở, không mang khoá của CR vừa ghi
    const lockedIn01 = (await DocBlock.find({ projectId, doc_version: "0.1", locked_by_cr: { $ne: null } }).lean()).map((b) => [b.block_id, b.locked_by_cr])
    expect(lockedIn01).toEqual(ucBlocks.map((b) => [b, ucCr.crId]))

    const proposed = detail(await c.post(`${ucCr.cr}/propose`))
    expect(detail(await c.post(`${ucCr.cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${ucCr.cr}/submit`))
    expect(proposed.groups.length).toBeGreaterThan(0)
    const written = await approveAll(c, ucCr.cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2", base_doc_version: "0.0" })

    const { v, pkg } = await loadVersion(projectId, "0.2")
    expect(v).toMatchObject({ based_on: "0.1", cr_ids: [ucCr.crId] })
    expect(await readStamp(pkg)).toMatchObject({ version: "0.2" })
    expect([ucCr.crId, perfCr.crId]).toEqual(["CR-001", "CR-002"])
    // edit của CR-002 (từ 0.1) còn nguyên; CR-001 chỉ thêm comment
    expect(new Set((await listRevisions(pkg)).map((r) => r.author))).toEqual(new Set([perfCr.crId]))
    expect((await listComments(pkg)).map((x) => `${x.author}: ${x.text}`)).toEqual([
      `${perfCr.crId}: Check "4.2.3 Performance"`,
      `${perfCr.crId}: Check "5.1 Business Rules"`,
      `${ucCr.crId}: Check "3.2.1 Register account"`,
      `${ucCr.crId}: Check "3.2.2 Log in to system"`
    ])
    expect(await DocBlock.countDocuments({ projectId, locked_by_cr: { $ne: null } })).toBe(0)
    expect((await DocVersion.find({ projectId }).sort({ createdAt: 1 }).lean()).map((x) => x.version)).toEqual(["0.0", "0.1", "0.2"])
  })
})

describe("C-7 chặn trước khi ghi", () => {
  it("base_version cũ ⇒ 409 SPINE_VERSION_CONFLICT; không file, không version, group vẫn pending", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const files = await gridFsFiles(projectId)
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: (await c.spineVersion()) - 1 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect(await gridFsFiles(projectId)).toBe(files)
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect((await ChangeGroup.findOne({ projectId, cr_id: crId, group_id: last }).lean())?.decision).toBe("pending")
  })

  it("text block đổi sau khi nộp ⇒ 409 CR_OLD_TEXT_MISMATCH, không ghi gì, vẫn giữ khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedBlocks(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const other = "The system shall respond within 5 seconds for 95% of requests."
    await DocBlock.updateOne({ projectId, doc_version: "0.0", block_id: "B0039" }, { $set: { text: other, text_hash: textHash(other) } })
    const files = await gridFsFiles(projectId)
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: await c.spineVersion() })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_OLD_TEXT_MISMATCH")
    expect(res.body.meta).toMatchObject({ block_id: "B0039" })
    expect(await gridFsFiles(projectId)).toBe(files)
    expect(await lockedBlocks(projectId, crId)).toEqual(held)
    expect(detail(await c.get(cr)).change_request.status).toBe("in_review")
  })
})

describe("C-7 lỗi giữa chừng", () => {
  const expectNothingWritten = async (c: Mode1Client, projectId: string, crId: string, cr: string, files: number, held: string[]) => {
    expect(await gridFsFiles(projectId)).toBe(files) // không file mồ côi
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect(await DocBlock.countDocuments({ projectId, doc_version: "0.1" })).toBe(0)
    expect(await lockedBlocks(projectId, crId)).toEqual(held)
    const d = detail(await c.get(cr))
    expect(d.change_request).toMatchObject({ status: "in_review", result_doc_version: null })
    expect(d.groups[d.groups.length - 1].decision).toBe("pending")
  }

  it("lưu file lỗi ⇒ không có gì được ghi (Spine không đổi); chạy lại cùng base_version ⇒ ghi được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedBlocks(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    vi.spyOn(gridFsDocFileStore, "save").mockRejectedValueOnce(new Error("GridFS down"))
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base })
    expect(res.status).toBe(500)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect(await c.spineVersion()).toBe(base)

    const retry = detail(await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base }))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })
    expect(await gridFsFiles(projectId)).toBe(files + 1)
  })

  it.each([
    ["DocBlock.insertMany", () => vi.spyOn(DocBlock, "insertMany").mockRejectedValueOnce(new Error("insert failed") as never)],
    ["DocVersion.create", () => vi.spyOn(DocVersion, "create").mockRejectedValueOnce(new Error("create failed") as never)]
  ])("%s lỗi (sau khi đã lưu file) ⇒ xoá file mồ côi + block dở, CR giữ nguyên; chạy lại (base_version mới) ⇒ ghi đúng một lần", async (_name, fail) => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedBlocks(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const files = await gridFsFiles(projectId)
    const saved = vi.spyOn(gridFsDocFileStore, "save")
    const removed = vi.spyOn(gridFsDocFileStore, "remove")
    fail()
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: await c.spineVersion() })
    expect(res.status).toBe(500)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith(await saved.mock.results[0].value)
    await expectNothingWritten(c, projectId, crId, cr, files, held)

    const retry = detail(await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })
    expect(await gridFsFiles(projectId)).toBe(files + 1)
    expect(await DocVersion.countDocuments({ projectId, version: "0.1" })).toBe(1)
    expect(await DocBlock.countDocuments({ projectId, doc_version: "0.1" })).toBe(await DocBlock.countDocuments({ projectId, doc_version: "0.0" }))
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")).toHaveLength(1)
    expect(await lockedBlocks(projectId, crId)).toEqual([])
  })

  /**
   * LỖI ĐÃ BIẾT (báo cáo P4): plan §6 2E yêu cầu op Spine + version + block trong **một transaction**, nhưng
   * `writeApproved` áp `applyTransaction` ngoài transaction và `catch` chỉ dọn block + file ⇒ lỗi sau bước Spine để
   * lại op của CR trên Spine (spine_version tăng, threshold = "1 s") trong khi CR vẫn in_review, tài liệu chưa đổi.
   * `it.fails`: đỏ khi lỗi được sửa — lúc đó đổi thành `it`.
   */
  it.fails("lỗi sau bước Spine ⇒ Spine giữ nguyên như trước khi ghi (chưa đạt — xem báo cáo)", async () => {
    const { c, projectId } = await importedProject()
    const { cr, submitted } = await crToReview(c)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const base = await c.spineVersion()
    vi.spyOn(DocVersion, "create").mockRejectedValueOnce(new Error("create failed") as never)
    expect((await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base })).status).toBe(500)
    expect(await c.spineVersion()).toBe(base)
    expect((await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("2 s")
  })
})

describe("C-7 duyệt một phần", () => {
  it("chỉ vị trí comment được duyệt (edit bị từ chối) ⇒ vẫn lên 0.1, không op Spine của CR", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, verified } = await crToReady(c)
    expect(verified.change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${cr}/submit`))
    const perf = submitted.groups.find((g) => g.title === "Performance")!
    const br = submitted.groups.find((g) => g.title === "Business Rules")!
    detail(await c.post(`${cr}/groups/${perf.group_id}/decision`, { decision: "rejected", reason: "Giữ nguyên 2 giây", base_version: await c.spineVersion() }))
    const written = detail(await c.post(`${cr}/groups/${br.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(written.change_request.result_doc_version).toBe("0.1")
    const { pkg } = await loadVersion(projectId, "0.1")
    expect(await listRevisions(pkg)).toEqual([])
    expect((await listComments(pkg)).map((x) => x.author)).toEqual([crId])
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path.startsWith("nfrs"))).toEqual([])
  })
})
