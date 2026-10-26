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
import { DocxPackage, acceptAll, readBlocks, readStamp } from "../../../src/modules/docx-ooxml/index.js"
import { wAll, wAttr } from "../../../src/modules/docx-ooxml/xml.js"
import { docFileStore, gridFsDocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { ChangeGroup } from "../../../src/modules/change-request/change-group.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as flagsService from "../../../src/modules/spine/flags.service.js"
import { MODE1_RULE_PROFILE } from "../../../src/modules/import/mode1-rule-profile.js"
import type { Flag } from "../../../src/modules/spine/spine.types.js"

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

/** FLF-330: BA xác nhận (`submit`) là ghi ngay — không còn duyệt từng group; đọc lại chi tiết CR đã ghi. */
const approveAll = async (c: Mode1Client, cr: string, _groups: { group_id: string }[]) => detail(await c.get(cr))

/** BA xác nhận (C-6). */
const confirm = (c: Mode1Client, cr: string) => c.post(`${cr}/submit`)

const loadVersion = async (projectId: string, version: string) => {
  const v = await DocVersion.findOne({ projectId, version }).lean()
  expect(v, `thiếu version ${version}`).not.toBeNull()
  const pkg = await DocxPackage.load(await docFileStore().load(v!.file_ref))
  return { v: v!, pkg, texts: (await readBlocks(pkg)).map((b) => b.text) }
}

const nfrThreshold = async (projectId: string) => (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")?.threshold

describe("C-7 ghi Spine + render version mới", () => {
  it("0.1 → 0.2: op của CR vào Spine; 0.2 = bản render từ Spine (stamp cr_revision, nội dung mới, §I có dòng của CR)", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })

    const { v, pkg, texts } = await loadVersion(projectId, "0.2")
    expect(v).toMatchObject({ kind: "cr_revision", based_on: "0.1", cr_ids: [crId], baseline_ref: null, original_ref: null })
    expect(await readStamp(pkg)).toMatchObject({ project_id: projectId, version: "0.2", source: "cr_revision" })
    expect(texts).toContain(NEW_PERF)
    expect(texts.join("\n")).not.toContain("within 2 seconds")
    expect(texts.some((t) => t.includes(`${crId}: Faster response time`))).toBe(true)
    expect(await nfrThreshold(projectId)).toBe("1 s")

    // BPMN 3.14 (mode 1 v3, T6): bản có đánh dấu — Track Changes tác giả = CR id, accept-all ra đúng bản sạch
    expect(v.tracked_file_ref).toBeTruthy()
    const tracked = await DocxPackage.load(await docFileStore().load(v.tracked_file_ref!))
    const doc = await tracked.requireXml("word/document.xml")
    const marks = [...wAll(doc, "ins"), ...wAll(doc, "del")]
    expect(marks.length).toBeGreaterThan(0)
    expect(new Set(marks.map((m) => wAttr(m, "author")))).toEqual(new Set([crId]))
    await acceptAll(tracked)
    expect((await readBlocks(tracked)).map((b) => b.text)).toEqual(texts)
    const dl = await c.get("/versions/0.2/download?variant=tracked").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on("data", (d: Buffer) => chunks.push(d))
      r.on("end", () => cb(null, Buffer.concat(chunks)))
    })
    expect(dl.status).toBe(200)
    expect(wAll(await (await DocxPackage.load(dl.body as Buffer)).requireXml("word/document.xml"), "ins").length).toBeGreaterThan(0)
  })

  it("phương án B: CR nhắm mục còn trống ⇒ duyệt xong Spine có phần tử mới, bản render có nội dung đó", async () => {
    const { c, projectId } = await importedProject()
    // C-2 trả đích là mã section còn trống; C-4 đề xuất thêm mới vào mảng nuôi mục đó
    const addOther = (p: string) =>
      JSON.stringify({
        locations: promptLocations(p).map((l) => ({
          location_id: l.location_id,
          conclusion: "edit",
          reason: "Mục còn trống — bổ sung yêu cầu khác",
          spine_ops: [{ op: "add", path: "other_requirements[]", value: { id: "OR-01", kind: "assumption", statement: "The system runs on Chrome 120 or newer." } }]
        }))
      })
    resetCrMock((p) => (p.includes("# CR Clarify") ? fakeCrClarify({ entity_paths: ["fixed:5.4"], keywords: [] })(p) : p.includes("# CR Propose") ? addOther(p) : undefined))

    const { crId, cr, impact } = await crToImpact(c)
    expect(impact.locations.map((l) => l.path)).toEqual(["other_requirements[]"])
    expect(detail(await c.post(`${cr}/propose`)).locations[0]).toMatchObject({ conclusion: "edit", proposal: { old_text: "[]" } })
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${cr}/submit`))
    const written = await approveAll(c, cr, submitted.groups)

    expect(written.change_request.status).toBe("written")
    const spine = (await spineRepository.get(projectId))!
    expect(spine.other_requirements).toMatchObject([{ id: "OR-01", kind: "assumption" }])
    const { texts } = await loadVersion(projectId, written.change_request.result_doc_version!)
    expect(texts.some((t) => t.includes("Chrome 120"))).toBe(true)
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("mode 1 v3: CR thêm được vào mục trống (không còn cờ đỏ section_empty) và đóng cờ đỏ unconfirmed_assumption (xác nhận giả định)", async () => {
    const { c, projectId } = await importedProject()
    // Giả định chưa xác nhận do import để lại — mode 1 không còn S-9.2 ⇒ chỉ CR đóng được cờ này
    await applyTransaction(projectId, {
      base_version: await c.spineVersion(),
      by: "test",
      reason: "seed giả định",
      step_id: null,
      ops: [{ op: "add", path: "assumptions[]", value: { id: "AS-01", path: "project.vision", statement: "Learners sign in with email.", rationale: "Not stated", origin_step_id: "S-7.2", status: "unconfirmed", confirmed_at: null } }]
    })
    await flagsService.recompute(projectId, { by: "test", ruleProfile: MODE1_RULE_PROFILE, atBaseline: true }) // như 1.12
    const redOpen = async () => (await c.get("/flags?level=red&open=true")).body.data as Flag[]
    const before = await redOpen()
    expect(before.some((f) => f.rule_id === "section_empty"), "mục FPT trống không bắt buộc ở mode 1").toBe(false)
    expect(before.some((f) => f.rule_id === "unconfirmed_assumption" && f.target_id === "AS-01")).toBe(true)

    const propose = (p: string) =>
      JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path === "other_requirements[]"
            ? { location_id: l.location_id, conclusion: "edit", reason: "Mục còn trống", spine_ops: [{ op: "add", path: "other_requirements[]", value: { id: "OR-01", kind: "assumption", statement: "The system runs on Chrome 120 or newer." } }] }
            : l.path === "assumptions[id=AS-01]"
              ? { location_id: l.location_id, conclusion: "edit", reason: "Khách xác nhận", spine_ops: [{ op: "set", path: "assumptions[id=AS-01].status", value: "confirmed" }] }
              : { location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] }
        )
      })
    resetCrMock((p) => (p.includes("# CR Clarify") ? fakeCrClarify({ entity_paths: ["fixed:5.4", "assumptions[id=AS-01]"], keywords: [] })(p) : p.includes("# CR Propose") ? propose(p) : undefined))

    const { cr, impact } = await crToImpact(c)
    expect(impact.locations.map((l) => l.path)).toEqual(expect.arrayContaining(["other_requirements[]", "assumptions[id=AS-01]"]))
    detail(await c.post(`${cr}/propose`))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const written = await approveAll(c, cr, detail(await c.post(`${cr}/submit`)).groups)
    expect(written.change_request.status).toBe("written")

    const after = await redOpen()
    expect(((await c.get("/spine")).body.data.other_requirements as { id: string }[]).map((r) => r.id), "mục trống đã có dữ liệu").toContain("OR-01")
    expect(after.some((f) => f.rule_id === "unconfirmed_assumption"), "giả định đã xác nhận ⇒ cờ đóng").toBe(false)
  })

  it("txn Spine: by = CR id, reason = 'CR id: tiêu đề'; mở hết khoá; bản làm việc ghép lại theo Spine mới", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const before = await c.spineVersion()
    detail(await confirm(c, cr))
    expect(await c.spineVersion()).toBeGreaterThan(before)
    const changes = (await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ value: "1 s", reason: `${crId}: Faster response time` })
    expect(await lockedPaths(projectId, crId)).toEqual([])
    const draft = await getDocument(projectId, "Lumen", { source: "draft" })
    const perf = draft.sections.find((s) => s.id === "fixed:4.2.3")!
    expect(JSON.stringify(perf.blocks)).toContain("1 s")
  })

  it("0.2 → 0.3: CR ghi sau render từ Spine đã có thay đổi của CR trước; khoá của CR đang mở không bị đụng khi CR khác ghi", async () => {
    const { c, projectId } = await importedProject()
    // CR-001 (UC-01/FR-3.2.2) khoá phần tử; CR-002 (perf) ghi trước ⇒ 0.2, rồi CR-001 ghi ⇒ 0.3
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
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.3", base_doc_version: "0.1" })

    const { v, pkg, texts } = await loadVersion(projectId, "0.3")
    expect(v).toMatchObject({ based_on: "0.2", cr_ids: [ucCr.crId] })
    expect(await readStamp(pkg)).toMatchObject({ version: "0.3" })
    expect(texts).toContain(NEW_PERF)
    expect(await lockedPaths(projectId, ucCr.crId)).toEqual([])
    expect((await DocVersion.find({ projectId }).sort({ createdAt: 1 }).lean()).map((x) => x.version)).toEqual(["0.1", "0.2", "0.3"])
  })
})

describe("C-6 chặn trước khi ghi (FLF-330: Code kiểm lại trên nội dung hiện tại lúc BA xác nhận)", () => {
  it("giá trị tại path đổi sau khi kiểm ⇒ xác nhận 409 CR_VALUE_CHANGED, không ghi gì, vẫn giữ khoá, CR vẫn ready_to_submit", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const held = await lockedPaths(projectId, crId)
    await Spine.updateOne({ projectId, "nfrs.id": "NFR-01" }, { $set: { "nfrs.$.threshold": "5 s" }, $inc: { spine_version: 1 } })
    const files = await gridFsFiles(projectId)
    const res = await confirm(c, cr)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_VALUE_CHANGED")
    expect(res.body.meta).toMatchObject({ path: "nfrs[id=NFR-01]" })
    expect(await gridFsFiles(projectId)).toBe(files)
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    expect(detail(await c.get(cr)).change_request.status).toBe("ready_to_submit")
    expect(await ChangeGroup.countDocuments({ projectId, cr_id: crId, decision: "pending" })).toBeGreaterThan(0)
  })
})

describe("C-7 lỗi giữa chừng", () => {
  const expectNothingWritten = async (c: Mode1Client, projectId: string, crId: string, cr: string, files: number, held: string[]) => {
    expect(await gridFsFiles(projectId)).toBe(files) // không file mồ côi
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    expect(await nfrThreshold(projectId)).toBe("2 s")
    const d = detail(await c.get(cr))
    expect(d.change_request).toMatchObject({ status: "ready_to_submit", result_doc_version: null })
    expect(d.groups.every((g) => g.decision === "pending")).toBe(true)
  }

  it("lưu file lỗi ⇒ không có gì được ghi (Spine không đổi); chạy lại cùng base_version ⇒ ghi được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const held = await lockedPaths(projectId, crId)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    vi.spyOn(gridFsDocFileStore, "save").mockRejectedValueOnce(new Error("GridFS down"))
    const res = await confirm(c, cr)
    expect(res.status).toBe(500)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect(await c.spineVersion()).toBe(base)

    const retry = detail(await confirm(c, cr))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    expect(await gridFsFiles(projectId), "bản sạch + bản có đánh dấu (3.14)").toBe(files + 2)
  })

  /** FLF-178: Spine là bước ghi cuối — lỗi tạo version (sau khi đã lưu file) ⇒ xoá file, Spine giữ nguyên. */
  it("DocVersion.create lỗi ⇒ xoá file mồ côi, Spine + CR giữ nguyên; chạy lại cùng base_version ⇒ ghi đúng một lần", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const held = await lockedPaths(projectId, crId)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    const saved = vi.spyOn(gridFsDocFileStore, "save")
    const removed = vi.spyOn(gridFsDocFileStore, "remove")
    vi.spyOn(DocVersion, "create").mockRejectedValueOnce(new Error("create failed") as never)
    const res = await confirm(c, cr)
    expect(res.status).toBe(500)
    // bản sạch + bản có đánh dấu (3.14) — lỗi tạo version ⇒ dọn cả hai
    expect(saved).toHaveBeenCalledTimes(2)
    expect(removed).toHaveBeenCalledWith(await saved.mock.results[0].value)
    expect(removed).toHaveBeenCalledWith(await saved.mock.results[1].value)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect(await c.spineVersion()).toBe(base)

    const retry = detail(await confirm(c, cr))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    expect(await gridFsFiles(projectId), "bản sạch + bản có đánh dấu (3.14)").toBe(files + 2)
    expect(await DocVersion.countDocuments({ projectId, version: "0.2" })).toBe(1)
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path === "nfrs[id=NFR-01].threshold")).toHaveLength(1)
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("Spine đổi ở phiên khác sau khi đã tạo version ⇒ 409, xoá version + file vừa tạo, CR giữ nguyên; tải lại rồi ghi được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    const held = await lockedPaths(projectId, crId)
    const files = await gridFsFiles(projectId)
    const base = await c.spineVersion()
    const create = DocVersion.create.bind(DocVersion)
    // "phiên khác" ghi Spine ngay sau khi version 0.2 được tạo, trước bước op Spine của CR
    vi.spyOn(DocVersion, "create").mockImplementationOnce((async (doc: unknown) => {
      const created = await create(doc as never)
      await Spine.updateOne({ projectId }, { $inc: { spine_version: 1 } })
      return created
    }) as never)
    const res = await confirm(c, cr)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(spineRepository.SPINE_VERSION_CONFLICT)
    await expectNothingWritten(c, projectId, crId, cr, files, held)
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId)).toEqual([])

    const retry = detail(await confirm(c, cr))
    expect(retry.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    expect(await DocVersion.countDocuments({ projectId, version: "0.2" })).toBe(1)
  })
})

describe("C-6 BA bỏ riêng một vị trí trước khi xác nhận (FLF-330 — thay cho Lead từ chối từng group)", () => {
  it("vị trí edit đặt not_related, chỉ còn comment ⇒ vẫn lên 0.2, không op Spine của CR", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, verified } = await crToReady(c)
    expect(verified.change_request.status).toBe("ready_to_submit")
    const perf = verified.locations.find((l) => l.path.startsWith("nfrs[id=NFR-01]"))!
    detail(await c.patch(`${cr}/locations/${perf.location_id}`, { conclusion: "not_related", reason: "Giữ nguyên 2 giây" }))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const written = detail(await confirm(c, cr))
    expect(written.change_request.status).toBe("written")
    expect(written.change_request.result_doc_version).toBe("0.2")
    expect(await nfrThreshold(projectId)).toBe("2 s")
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId)).toEqual([])
    expect((await loadVersion(projectId, "0.2")).v.cr_ids).toEqual([crId])
  })
})
