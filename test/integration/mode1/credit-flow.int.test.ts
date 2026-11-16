/**
 * Flow 4 cho mode 1 v3 (BPMN 4.2 báo nạp, BR-01/BR-08 chỉ mở lại thủ công) — `import/credit-flow.service.ts`:
 * - bước AI dừng vì hết credit ⇒ Lead của tổ chức nhận thông báo nạp hướng dẫn mở lại dự án và bấm tiếp tục (không tự chạy lại);
 * - nạp xong ⇒ CR vẫn giữ nguyên trạng thái `paused`, thành viên nhận `credit_topped_up` và tự bấm `/resume` để chạy tiếp.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToImpact, crDoc, detail, importedProject, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { TOPUP_NEEDED } from "../../../src/modules/import/credit-flow.service.js"
import { fulfillTopupRequests } from "../../../src/modules/billing/topup-request.service.js"

beforeEach(() => resetCrMock())

const topUpNotices = async (userId: string) => {
  // notify chạy nền (`void`) ⇒ chờ bản ghi xuất hiện
  for (let i = 0; i < 50; i++) {
    const rows = await Notification.find({ userId, type: TOPUP_NEEDED }).lean()
    if (rows.length) return rows
    await new Promise((r) => setTimeout(r, 20))
  }
  return []
}

describe("Flow 4 - mode 1", () => {
  it("4.2: hết credit ở C-4 ⇒ CR paused credits + chủ project nhận thông báo nạp hướng dẫn mở lại dự án và bấm tiếp tục", async () => {
    const { c, seeded, projectId } = await importedProject()
    const { cr } = await crToImpact(c)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 0 } })

    const d = detail(await c.post(`${cr}/propose`))
    expect(d.change_request.paused?.reason).toBe("credits")
    const [notice] = await topUpNotices(seeded.userId)
    expect(notice).toMatchObject({ title: "Hết credit - bước AI đang dừng", link: "/home/billing", meta: { project_id: projectId } })
    expect(notice.body).not.toContain("tự chạy lại")
    expect(notice.body).toContain("mở lại dự án và bấm tiếp tục")
    expect(String((notice.meta as { step_id: string }).step_id)).toMatch(/^C-4:CR-/)
  })

  it("BR-01/BR-08: nạp xong KHÔNG tự chạy lại (cả paused credits lẫn resume_later); bấm POST /change-requests/:crId/resume mới chạy tiếp", async () => {
    const { c, seeded, projectId } = await importedProject()
    const { cr, crId } = await crToImpact(c)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 0 } })
    expect(detail(await c.post(`${cr}/propose`)).change_request.paused?.reason).toBe("credits")

    const secondCrId = await newCr(c, "Second CR", "Change the password rule of BR-01 to 10 characters.")
    const other = await crDoc(projectId, secondCrId)
    await ChangeRequest.updateOne({ _id: other._id }, { $set: { status: "proposing", paused: { reason: "resume_later", at: new Date() } } })

    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 1000 } })
    expect(await fulfillTopupRequests(seeded.orgId, 1000, { kind: "admin", userId: null })).toBe(1)

    // Không tự chạy lại sau khi nạp
    expect((await crDoc(projectId, crId)).paused?.reason).toBe("credits")
    expect((await crDoc(projectId, secondCrId)).paused?.reason).toBe("resume_later")
    const toppedUp = await Notification.find({ userId: seeded.userId, type: "credit_topped_up" }).lean()
    expect(toppedUp).toHaveLength(1)
    expect(toppedUp[0].body).toContain("bấm tiếp tục")

    // Thành viên tự bấm tiếp tục qua POST /change-requests/:crId/resume ⇒ chạy xong mọi vị trí
    const resumed = detail(await c.post(`${cr}/resume`))
    expect(resumed.change_request.paused).toBeNull()
    expect(resumed.change_request.status).toBe("proposing")
    expect(resumed.locations.every((l) => l.conclusion !== null)).toBe(true)
    expect((await crDoc(projectId, secondCrId)).paused?.reason).toBe("resume_later")
  })
})
