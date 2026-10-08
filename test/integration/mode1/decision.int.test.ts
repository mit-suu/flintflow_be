/**
 * C-6 duyệt / từ chối change group (`decision.service.ts`, nút 3.11–3.13, UC-52) + sửa lại / đóng CR.
 * FLF-172, plan §8.3. Ca chính: duyệt một phần mở khoá group bị từ chối ngay; tất cả từ chối ⇒ revise/close;
 * notification được gửi. Thêm: group đã quyết / không tồn tại, lý do từ chối bắt buộc, revise khi còn group chưa từ chối.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToReview, newCr, detail, importedProject, lockedPaths, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { lockPaths } from "../../../src/modules/change-request/lock.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { ChangeGroup } from "../../../src/modules/change-request/change-group.model.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"

beforeEach(() => resetCrMock())

const REASON = "Ngoài phạm vi bản 1.0"

const decide = async (c: Mode1Client, cr: string, gid: string, decision: "approved" | "rejected", reason?: string) =>
  c.post(`${cr}/groups/${gid}/decision`, { decision, ...(reason ? { reason } : decision === "approved" ? { reason: "Đúng yêu cầu của khách" } : {}), base_version: await c.spineVersion() })

/** notify chạy nền (`void notify(...)`) ⇒ chờ bản ghi xuất hiện. */
const notificationsOf = async (userId: string, n: number) => {
  await vi.waitFor(async () => expect(await Notification.countDocuments({ userId, type: "change_request_decided" })).toBe(n), { timeout: 3000 })
  return Notification.find({ userId, type: "change_request_decided" }).sort({ createdAt: 1, _id: 1 }).lean()
}

describe("C-6 duyệt một phần", () => {
  it("từ chối G02 ⇒ mở khoá phần tử của G02 ngay, G01 vẫn khoá, CR vẫn in_review; duyệt G01 ⇒ ghi Spine + version, written", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const [g1, g2] = submitted.groups
    // tiêu đề group theo chính heading trong file người dùng
    expect([g1.title, g2.title]).toEqual(["4.2.3 Performance", "5.1 Business Rules"])
    const pathsOf = (gid: string) => submitted.locations.filter((l) => l.group_id === gid).map((l) => l.path).sort()

    const rejected = detail(await decide(c, cr, g2.group_id, "rejected", REASON))
    expect(rejected.change_request.status).toBe("in_review")
    expect(rejected.groups.find((g) => g.group_id === g2.group_id)).toMatchObject({ decision: "rejected", reason: REASON, decided_by: seeded.userId })
    expect(rejected.groups.find((g) => g.group_id === g2.group_id)?.decided_at).not.toBeNull()
    expect(await lockedPaths(projectId, crId)).toEqual(pathsOf(g1.group_id))
    // chưa quyết hết ⇒ chưa ghi version
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)

    const written = detail(await decide(c, cr, g1.group_id, "approved"))
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.1", decided_by: seeded.userId })
    expect(written.groups.map((g) => g.decision)).toEqual(["approved", "rejected"])
    // chỉ vị trí của group duyệt được ghi: op của NFR-01 (G01) vào Spine, by = mã CR
    const v01 = await DocVersion.findOne({ projectId, version: "0.1" }).lean()
    expect(v01?.cr_ids).toEqual([crId])
    const spine = (await spineRepository.get(projectId))!
    expect(spine.nfrs.find((n) => n.id === "NFR-01")?.threshold).toBe("1 s")
    const changes = await spineRepository.listChanges(projectId)
    expect(changes.filter((ch) => ch.by === crId).map((ch) => ch.path).sort()).toEqual(["nfrs[id=NFR-01].statement", "nfrs[id=NFR-01].threshold"])
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("notification: mỗi quyết định một thông báo; lần cuối báo version đã ghi", async () => {
    const { c, seeded } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const [g1, g2] = submitted.groups
    detail(await decide(c, cr, g2.group_id, "rejected", REASON))
    detail(await decide(c, cr, g1.group_id, "approved"))
    const [first, last] = await notificationsOf(seeded.userId, 2)
    expect(first).toMatchObject({ title: `${crId}: nhóm thay đổi “${g2.title}” bị từ chối`, meta: { cr_id: crId, group_id: g2.group_id, decision: "rejected", result_doc_version: null } })
    expect(first.body).toContain(REASON)
    expect(last).toMatchObject({ title: `${crId} đã được ghi vào bản 0.1`, meta: { cr_id: crId, group_id: g1.group_id, decision: "approved", result_doc_version: "0.1" } })
  })

  it("duyệt group đầu khi còn group chờ ⇒ chưa ghi, thông báo 'được duyệt', vẫn giữ khoá", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const held = await lockedPaths(projectId, crId)
    const d = detail(await decide(c, cr, submitted.groups[0].group_id, "approved"))
    expect(d.change_request).toMatchObject({ status: "in_review", result_doc_version: null })
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    const [n] = await notificationsOf(seeded.userId, 1)
    expect(n.title).toBe(`${crId}: nhóm thay đổi “${submitted.groups[0].title}” được duyệt`)
    expect(n.title).not.toContain("G0")
  })
})

describe("C-6 lỗi quyết định", () => {
  it("group đã quyết ⇒ 409; group không tồn tại ⇒ 404; từ chối thiếu lý do ⇒ 400; quyết khi chưa nộp ⇒ 409", async () => {
    const { c } = await importedProject()
    const { cr, submitted } = await crToReview(c)
    const g = submitted.groups[0].group_id
    detail(await decide(c, cr, g, "approved"))
    const again = await decide(c, cr, g, "rejected", REASON)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("CR_INVALID_TRANSITION")
    const missing = await decide(c, cr, "G09", "approved")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("CR_GROUP_NOT_FOUND")
    expect((await decide(c, cr, submitted.groups[1].group_id, "rejected")).status).toBe(400)
    expect((await c.post(`${cr}/groups/G1/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: 1 })).status).toBe(400)

    const other = await newCr(c, "Second CR", "Change the password rule of BR-01 to 10 characters.")
    const early = await decide(c, `/change-requests/${other}`, "G01", "approved")
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("CR_INVALID_TRANSITION")
  })
})

describe("C-6 tất cả bị từ chối ⇒ sửa lại hoặc đóng", () => {
  it("revise: khoá lại phần tử, xoá group, xoá đề xuất/kết quả verify, về proposing; propose lại chạy được", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
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

  it("revise khi còn group chưa bị từ chối ⇒ 409, không đổi gì", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    detail(await decide(c, cr, submitted.groups[1].group_id, "rejected", REASON))
    const res = await c.post(`${cr}/revise`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_INVALID_TRANSITION")
    expect(await ChangeGroup.countDocuments({ projectId, cr_id: crId })).toBe(2)
    expect(await ChangeLocation.countDocuments({ projectId, cr_id: crId, proposal: { $ne: null } })).toBe(2)
  })

  it("revise khi phần tử đã bị CR khác giành trong lúc chờ ⇒ 409 PATH_LOCKED, group + đề xuất giữ nguyên", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    for (const g of submitted.groups) detail(await decide(c, cr, g.group_id, "rejected", REASON))
    await lockPaths(projectId, "CR-777", ["business_rules[id=BR-01]"])
    const res = await c.post(`${cr}/revise`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PATH_LOCKED")
    expect(res.body.meta.locked).toEqual([{ path: "business_rules[id=BR-01]", cr_id: "CR-777" }])
    expect(await ChangeGroup.countDocuments({ projectId, cr_id: crId, decision: "rejected" })).toBe(2)
    expect(await lockedPaths(projectId, crId)).toEqual([])
    expect(detail(await c.get(cr)).change_request.status).toBe("in_review")
  })

  it("close: rejected + lý do + người quyết, mở hết khoá, không tạo version", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    for (const g of submitted.groups) detail(await decide(c, cr, g.group_id, "rejected", REASON))
    const closed = detail(await c.post(`${cr}/close`, { reason: "Khách hàng bỏ yêu cầu" }))
    expect(closed.change_request).toMatchObject({ status: "rejected", closed_reason: "Khách hàng bỏ yêu cầu", decided_by: seeded.userId })
    expect(await lockedPaths(projectId, crId)).toEqual([])
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    await notificationsOf(seeded.userId, 2)
    // đã đóng ⇒ không revise / quyết được nữa
    expect((await c.post(`${cr}/revise`)).status).toBe(409)
    expect((await decide(c, cr, submitted.groups[0].group_id, "approved")).status).toBe(409)
  })
})
