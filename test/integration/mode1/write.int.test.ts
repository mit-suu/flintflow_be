/**
 * C-7 ghi thay đổi đã duyệt (`write.service.ts`, nút 3.14) trên Mongo + GridFS thật.
 * Mode 1 v2 (FLF-186): Spine là nguồn sự thật — op của CR ghi vào Spine (by = CR id), version minor mới là bản render
 * từ Spine (stamp, §I có dòng của CR); ghi ngay khi duyệt xong (D4). Lỗi giữa chừng không để file / version mồ côi,
 * Spine ghi cuối cùng (FLF-178) và chạy lại được. Lỗi giả lập bằng `vi.spyOn` trên model / store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToImpact, crToReady, crToReview, detail, gridFsFiles, importedProject, lockedPaths, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose, promptLocations } from "../../helpers/mode1.js"
import { DocxPackage, readBlocks, readStamp } from "../../../src/modules/docx-ooxml/index.js"
import { docFileStore, gridFsDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { ChangeGroup } from "../../../src/modules/change-request/change-group.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

/** C-2: CR "Rename registration" ⇒ đích UC-01 / FR-3.2.2 (không chồng phần tử với CR perf); C-4 ghi chú mọi vị trí. */
const UC_TARGETS = { entity_paths: ["use_cases[id=UC-01]", "functions[id=FR-3.2.2]"], keywords: [] }
const commentAll = (p: string) =>
  JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "comment", reason: "r", comment_text: `Check ${l.path}`, spine_ops: [] })) })
const route = (p: string) => {
  const uc = p.includes("Rename registration")
  if (p.includes("# CR Clarify")) return fakeCrClarify(uc ? UC_TARGETS : PERF_TARGETS)(p)
  if (p.includes("# CR Propose")) return uc ? commentAll(p) : fakeCrPropose(p)
  return undefined
}

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
  const pkg = await DocxPackage.load(await docFileStore().load(v!.file_ref))
  return { v: v!, pkg, texts: (await readBlocks(pkg)).map((b) => b.text) }
}

const nfrThreshold = async (projectId: string) => (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")?.threshold

describe("C-7 ghi Spine + render version mới", () => {
  it("0.0 → 0.1: op của CR vào Spine; 0.1 = bản render từ Spine (stamp cr_revision, nội dung mới, §I có dòng của CR)", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })

    const { v, pkg, texts } = await loadVersion(projectId, "0.1")
    expect(v).toMatchObject({ kind: "cr_revision", based_on: "0.0", cr_ids: [crId], baseline_ref: null, original_ref: null })
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId, version: "0.1", source: "cr_revision" })
    expect(texts).toContain(NEW_PERF)
    expect(texts.join("\n")).not.toContain("within 2 seconds")
    expect(texts.some((t) => t.includes(`${crId}: Faster response time`))).toBe(true)
    expect(await nfrThreshold(projectId)).toBe("1 s")
  })

  it("txn Spine: by = CR id, reason = 'CR id: tiêu đề'; mở hết khoá; bản làm việc ghép lại theo Spine mới", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const before = await c.spineVersion()
    await approveAll(c, cr, submitted.groups)
    expect(await c.spineVersion()).toBeGreaterThan(before)
    const changes = (await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ value: "1 s", reason: `${crId}: Faster response time` })
    expect(await lockedPaths(projectId, crId)).toEqual([])
    const draft = await getDocument(projectId, "Lumen", { source: "draft" })
    const perf = draft.sections.find((s) => s.id === "fixed:4.2.3")!
    expect(JSON.stringify(perf.blocks)).toContain("1 s")
  })

  it("0.1 → 0.2: CR ghi sau render từ Spine đã có thay đổi của CR trước; khoá của CR đang mở không bị đụng khi CR khác ghi", async () => {
    const { c, projectId } = await importedProject()
    // CR-001 (UC-01/FR-3.2.2) khoá phần tử; CR-002 (perf) ghi trước ⇒ 0.1, rồi CR-001 ghi ⇒ 0.2
    const ucCr = await crToImpact(c, "Rename registration", "Rename UC-01 and adjust the login function.")
    const ucPaths = await lockedPaths(projectId, ucCr.crId)
    expect(ucPaths).toEqual(expect.arrayContaining(["functions[id=FR-3.2.2]", "use_cases[id=UC-01]"]))
    const perfCr = await crToReview(c)
    await approveAll(c, perfCr.cr, perfCr.submitted.groups)
    expect(await lockedPaths(projectId, ucCr.crId)).toEqual(ucPaths)

    detail(await c.post(`${ucCr.cr}/propose`))
    expect(detail(await c.post(`${ucCr.cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${ucCr.cr}/submit`))
    const written = await approveAll(c, ucCr.cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2", base_doc_version: "0.0" })

    const { v, pkg, texts } = await loadVersion(projectId, "0.2")
    expect(v).toMatchObject({ based_on: "0.1", cr_ids: [ucCr.crId] })
    expect(await readStamp(pkg)).toMatchObject({ version: "0.2" })
    expect(texts).toContain(NEW_PERF)
    expect(await lockedPaths(projectId, ucCr.crId)).toEqual([])
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

  it("giá trị tại path đổi sau khi nộp ⇒ 409 CR_VALUE_CHANGED, không ghi gì, vẫn giữ khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedPaths(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    await Spine.updateOne({ projectId, "nfrs.id": "NFR-01" }, { $set: { "nfrs.$.threshold": "5 s" } })
    const files = await gridFsFiles(projectId)
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: await c.spineVersion() })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_VALUE_CHANGED")
    expect(res.body.meta).toMatchObject({ path: "nfrs[id=NFR-01]" })
    expect(await gridFsFiles(projectId)).toBe(files)
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    expect(detail(await c.get(cr)).change_request.status).toBe("in_review")
  })
})

describe("C-7 lỗi giữa chừng", () => {
  const expectNothingWritten = async (c: Mode1Client, projectId: string, crId: string, cr: string, files: number, held: string[]) => {
    expect(await gridFsFiles(projectId)).toBe(files) // không file mồ côi
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    expect(await nfrThreshold(projectId)).toBe("2 s")
    const d = detail(await c.get(cr))
    expect(d.change_request).toMatchObject({ status: "in_review", result_doc_version: null })
    expect(d.groups[d.groups.length - 1].decision).toBe("pending")
  }

  it("lưu file lỗi ⇒ không có gì được ghi (Spine không đổi); chạy lại cùng base_version ⇒ ghi được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedPaths(projectId, crId)
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

  /** FLF-178: Spine là bước ghi cuối — lỗi tạo version (sau khi đã lưu file) ⇒ xoá file, Spine giữ nguyên. */
  it("DocVersion.create lỗi ⇒ xoá file mồ côi, Spine + CR giữ nguyên; chạy lại cùng base_version ⇒ ghi đúng một lần", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedPaths(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    const saved = vi.spyOn(gridFsDocFileStore, "save")
    const removed = vi.spyOn(gridFsDocFileStore, "remove")
    vi.spyOn(DocVersion, "create").mockRejectedValueOnce(new Error("create failed") as never)
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base })
    expect(res.status).toBe(500)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith(await saved.mock.results[0].value)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect(await c.spineVersion()).toBe(base)

    const retry = detail(await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base }))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })
    expect(await gridFsFiles(projectId)).toBe(files + 1)
    expect(await DocVersion.countDocuments({ projectId, version: "0.1" })).toBe(1)
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")).toHaveLength(1)
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("Spine đổi ở phiên khác sau khi đã tạo version ⇒ 409, xoá version + file vừa tạo, CR giữ nguyên; tải lại rồi ghi được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedPaths(projectId, crId)
    const last = await approveAllButLast(c, cr, submitted.groups)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    const create = DocVersion.create.bind(DocVersion)
    // "phiên khác" ghi Spine ngay sau khi version 0.1 được tạo, trước bước op Spine của CR
    vi.spyOn(DocVersion, "create").mockImplementationOnce((async (doc: unknown) => {
      const created = await create(doc as never)
      await Spine.updateOne({ projectId }, { $inc: { spine_version: 1 } })
      return created
    }) as never)
    const res = await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: base })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(spineRepository.SPINE_VERSION_CONFLICT)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId)).toEqual([])

    const retry = detail(await c.post(`${cr}/groups/${last}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })
    expect(await DocVersion.countDocuments({ projectId, version: "0.1" })).toBe(1)
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
    expect(await nfrThreshold(projectId)).toBe("2 s")
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId)).toEqual([])
    expect((await loadVersion(projectId, "0.1")).v.cr_ids).toEqual([crId])
  })
})
