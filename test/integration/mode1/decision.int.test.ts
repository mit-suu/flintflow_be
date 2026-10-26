/**
 * C-6 (FLF-330, business-flow §3.2): BA **xác nhận** CR ⇒ Code kiểm lại rồi ghi ngay vào bản nháp chung — CR là một
 * commit, Lead không duyệt từng CR. Vị trí BA bỏ riêng (`not_related`) không ghi. Thông báo "đã ghi vào bản nháp".
 * Luồng cũ (`in_review` → duyệt từng group → sửa lại / đóng) chỉ còn cho CR tạo trước FLF-330: kiểm bằng cách ép trạng thái.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToReady, crToReview, newCr, detail, importedProject, lockedPaths, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { lockPaths } from "../../../src/modules/change-request/lock.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { ChangeGroup } from "../../../src/modules/change-request/change-group.model.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"

beforeEach(() => resetCrMock())

const REASON = "Ngoài phạm vi bản 1.0"

const decide = async (c: Mode1Client, cr: string, gid: string, decision: "approved" | "rejected", reason?: string) =>
  c.post(`${cr}/groups/${gid}/decision`, { decision, ...(reason ? { reason } : decision === "approved" ? { reason: "Đúng yêu cầu của khách" } : {}), base_version: await c.spineVersion() })

/** notify chạy nền (`void notify(...)`) ⇒ chờ bản ghi xuất hiện. */
const notificationsOf = async (userId: string, type: string, n: number) => {
  await vi.waitFor(async () => expect(await Notification.countDocuments({ userId, type })).toBe(n), { timeout: 3000 })
  return Notification.find({ userId, type }).sort({ createdAt: 1, _id: 1 }).lean()
}

/** CR tạo trước FLF-330 đang chờ Lead duyệt từng group. */
const legacyInReview = async (c: Mode1Client, projectId: string) => {
  const ready = await crToReady(c)
  await ChangeRequest.updateOne({ projectId, cr_id: ready.crId }, { $set: { status: "in_review", submitted_at: new Date() } })
  return { ...ready, submitted: detail(await c.get(ready.cr)) }
}

describe("C-6 BA xác nhận ⇒ ghi ngay (FLF-330)", () => {
  it("xác nhận ⇒ written 0.2, mọi group 'đã duyệt' bởi người xác nhận, op Spine by = CR, mở hết khoá, 1 thông báo đã ghi", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, submitted } = await crToReview(c)
    expect(submitted.change_request).toMatchObject({ status: "written", result_doc_version: "0.2", decided_by: seeded.userId })
    expect(submitted.change_request.submitted_at).not.toBeNull()
    expect(submitted.groups.map((g) => [g.title, g.decision, g.decided_by])).toEqual([
      ["4.2.3 Performance", "approved", seeded.userId],
      ["5.1 Business Rules", "approved", seeded.userId]
    ])
    expect((await DocVersion.findOne({ projectId, version: "0.2" }).lean())?.cr_ids).toEqual([crId])
    const spine = (await spineRepository.get(projectId))!
    expect(spine.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("1 s")
    const changes = await spineRepository.listChanges(projectId)
    expect(changes.filter((ch) => ch.by === crId).map((ch) => ch.path).sort()).toEqual(["nfrs[id=NFR-01].statement", "nfrs[id=NFR-01].threshold"])
    expect(await lockedPaths(projectId, crId)).toEqual([])

    const [n] = await notificationsOf(seeded.userId, "change_request_written", 1)
    expect(n.title).toBe(`${crId} đã ghi vào bản nháp`)
    expect(n.meta).toMatchObject({ cr_id: crId, result_doc_version: "0.2" })
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "change_request_decided" })).toBe(0)
  })

  it("BA bỏ riêng vị trí BR (not_related) trước khi xác nhận ⇒ chỉ NFR được ghi, group BR không còn", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, verified } = await crToReady(c)
    const br = verified.locations.find((l) => l.path === "business_rules[id=BR-01]")!
    detail(await c.patch(`${cr}/locations/${br.location_id}`, { conclusion: "not_related", reason: REASON }))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")

    const written = detail(await c.post(`${cr}/submit`))
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    expect(written.groups.map((g) => [g.title, g.decision])).toEqual([["4.2.3 Performance", "approved"]])
    const spine = (await spineRepository.get(projectId))!
    expect(spine.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("1 s")
    expect((await spineRepository.listChanges(projectId)).filter((ch) => ch.by === crId && ch.path.startsWith("business_rules"))).toEqual([])
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("xác nhận khi chưa qua kiểm ⇒ 409; CR đã ghi không duyệt lại được qua group (luồng cũ) ⇒ 409", async () => {
    const { c } = await importedProject()
    const other = await newCr(c, "Second CR", "Change the password rule of BR-01 to 10 characters.")
    const early = await c.post(`/change-requests/${other}/submit`)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("CR_INVALID_TRANSITION")

    const { cr, submitted } = await crToReview(c)
    const again = await decide(c, cr, submitted.groups[0].group_id, "approved")
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("CR_INVALID_TRANSITION")
  })
})

describe("Luồng cũ (CR tạo trước FLF-330 còn in_review) — duyệt từng group, sửa lại, đóng vẫn chạy", () => {
  it("từ chối G02 ⇒ mở khoá phần tử của G02, G01 vẫn khoá; duyệt G01 ⇒ written", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, submitted } = await legacyInReview(c, projectId)
    const [g1, g2] = submitted.groups
    const pathsOf = (gid: string) => submitted.locations.filter((l) => l.group_id === gid).map((l) => l.path).sort()

    const rejected = detail(await decide(c, cr, g2.group_id, "rejected", REASON))
    expect(rejected.change_request.status).toBe("in_review")
    expect(rejected.groups.find((g) => g.group_id === g2.group_id)).toMatchObject({ decision: "rejected", reason: REASON, decided_by: seeded.userId })
    expect(await lockedPaths(projectId, crId)).toEqual(pathsOf(g1.group_id))
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)

    const written = detail(await decide(c, cr, g1.group_id, "approved"))
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    expect(written.groups.map((g) => g.decision)).toEqual(["approved", "rejected"])
    expect(await lockedPaths(projectId, crId)).toEqual([])
    await notificationsOf(seeded.userId, "change_request_decided", 2)
  })

  it("group đã quyết ⇒ 409; group không tồn tại ⇒ 404; từ chối thiếu lý do ⇒ 400", async () => {
    const { c, projectId } = await importedProject()
    const { cr, submitted } = await legacyInReview(c, projectId)
    const g = submitted.groups[0].group_id
    detail(await decide(c, cr, g, "approved"))
    const again = await decide(c, cr, g, "rejected", REASON)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("CR_INVALID_TRANSITION")
    const missing = await decide(c, cr, "G09", "approved")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("CR_GROUP_NOT_FOUND")
    expect((await decide(c, cr, submitted.groups[1].group_id, "rejected")).status).toBe(400)
  })

  it("mọi group bị từ chối ⇒ revise: khoá lại, xoá group + đề xuất, về proposing; propose lại chạy được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await legacyInReview(c, projectId)
    for (const g of submitted.groups) detail(await decide(c, cr, g.group_id, "rejected", REASON))
    expect(await lockedPaths(projectId, crId)).toEqual([])
    const revised = detail(await c.post(`${cr}/revise`))
    expect(revised.change_request).toMatchObject({ status: "proposing", submitted_at: null })
    expect(revised.groups).toEqual([])
    expect(revised.locations.every((l) => l.conclusion === null && l.proposal === null && l.verify === null && l.group_id === null && l.redo_count === 0 && !l.manual)).toBe(true)
    expect(await lockedPaths(projectId, crId)).toEqual(submitted.locations.map((l) => l.path).sort())
    expect(await ChangeGroup.countDocuments({ projectId, cr_id: crId })).toBe(0)

    const again = detail(await c.post(`${cr}/propose`))
    expect(again.groups.map((g) => g.decision)).toEqual(["pending", "pending"])
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
  })

  it("revise khi phần tử đã bị CR khác giành ⇒ 409 PATH_LOCKED; close ⇒ rejected, mở hết khoá, không tạo version", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, submitted } = await legacyInReview(c, projectId)
    for (const g of submitted.groups) detail(await decide(c, cr, g.group_id, "rejected", REASON))
    await lockPaths(projectId, "CR-777", ["business_rules[id=BR-01]"])
    const res = await c.post(`${cr}/revise`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PATH_LOCKED")
    expect(await ChangeGroup.countDocuments({ projectId, cr_id: crId, decision: "rejected" })).toBe(2)
    expect(await ChangeLocation.countDocuments({ projectId, cr_id: crId, proposal: { $ne: null } })).toBe(2)

    const closed = detail(await c.post(`${cr}/close`, { reason: "Khách hàng bỏ yêu cầu" }))
    expect(closed.change_request).toMatchObject({ status: "rejected", closed_reason: "Khách hàng bỏ yêu cầu", decided_by: seeded.userId })
    expect(await lockedPaths(projectId, crId)).toEqual([])
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect((await c.post(`${cr}/revise`)).status).toBe(409)
  })
})
