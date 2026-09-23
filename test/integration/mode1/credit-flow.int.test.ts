/**
 * Flow 4 cho mode 1 v3 (BPMN 4.2 báo nạp, 4.5 ⇒ 4.1 chạy tiếp) — `import/credit-flow.service.ts`:
 * - bước AI dừng vì hết credit ⇒ chủ project nhận thông báo nạp;
 * - nạp xong ⇒ mọi bước dừng vì hết credit chạy tiếp; bước dừng vì lỗi AI (`resume_later`) KHÔNG tự chạy lại.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToImpact, crDoc, detail, importedProject, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { TOPUP_NEEDED, resumeAfterTopUp } from "../../../src/modules/import/credit-flow.service.js"

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

describe("Flow 4 — mode 1", () => {
  it("4.2: hết credit ở C-4 ⇒ CR paused credits + chủ project nhận thông báo nạp (link trang nạp, bước đang dừng)", async () => {
    const { c, seeded, projectId } = await importedProject()
    const { cr } = await crToImpact(c)
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })

    const d = detail(await c.post(`${cr}/propose`))
    expect(d.change_request.paused?.reason).toBe("credits")
    const [notice] = await topUpNotices(seeded.userId)
    expect(notice).toMatchObject({ title: "Hết credit — bước AI đang dừng", link: "/home/billing", meta: { project_id: projectId } })
    expect(String((notice.meta as { step_id: string }).step_id)).toMatch(/^C-4:CR-/)
  })

  it("4.5 ⇒ 4.1: nạp xong ⇒ bước dừng vì hết credit chạy tiếp; bước dừng vì lỗi AI (để sau) không tự chạy", async () => {
    const { c, seeded, projectId } = await importedProject()
    const { crId } = await crToImpact(c)
    const cr = await crDoc(projectId, crId)
    await ChangeRequest.updateOne({ _id: cr._id }, { $set: { status: "proposing", paused: { reason: "credits", at: new Date() } } })
    const second = { crId: await newCr(c, "Second CR", "Change the password rule of BR-01 to 10 characters.") }
    const other = await crDoc(projectId, second.crId)
    await ChangeRequest.updateOne({ _id: other._id }, { $set: { status: "proposing", paused: { reason: "resume_later", at: new Date() } } })

    const resumeCr = vi.fn(async () => undefined)
    const resumed = await resumeAfterTopUp(seeded.userId, { resumeExtraction: vi.fn(), resumeCheck: vi.fn(), resumeCr })
    expect(resumed).toBe(1)
    expect(resumeCr).toHaveBeenCalledWith(projectId, crId, seeded.userId)
    expect(resumeCr).not.toHaveBeenCalledWith(projectId, second.crId, expect.anything())
  })

  it("4.5 ⇒ 4.1 với dịch vụ thật: CR dừng vì hết credit ở C-4 ⇒ nạp ⇒ chạy tiếp, đề xuất xong mọi vị trí", async () => {
    const { c, seeded, projectId } = await importedProject()
    const { cr, crId } = await crToImpact(c)
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    expect(detail(await c.post(`${cr}/propose`)).change_request.paused?.reason).toBe("credits")

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 1000 } })
    expect(await resumeAfterTopUp(seeded.userId)).toBe(1)
    const after = await crDoc(projectId, crId)
    expect(after.paused).toBeNull()
    expect(after.status).toBe("proposing")
    expect(detail(await c.get(cr)).locations.every((l) => l.conclusion !== null)).toBe(true)
  })

  it("không có project mode 1 ⇒ không làm gì", async () => {
    expect(await resumeAfterTopUp("650000000000000000000abc", { resumeExtraction: vi.fn(), resumeCheck: vi.fn(), resumeCr: vi.fn() })).toBe(0)
  })
})
