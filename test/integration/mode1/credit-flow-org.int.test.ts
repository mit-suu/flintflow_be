/**
 * task-26 × Flow 4 mode 1 — sau khi gộp develop: ví là của TỔ CHỨC và chỉ Lead được nạp.
 * - 4.2: hết credit ⇒ báo Lead của tổ chức, không báo người tạo dự án (có thể là Analyst, không nạp được).
 * - 4.5 ⇒ 4.1: nạp vào ví tổ chức ⇒ chạy tiếp cả dự án do thành viên khác tạo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToImpact, crDoc, detail, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { TOPUP_NEEDED, resumeAfterTopUp } from "../../../src/modules/import/credit-flow.service.js"

beforeEach(() => resetCrMock())

/** notify chạy nền ⇒ chờ bản ghi xuất hiện. */
const waitForNotices = async (userId: string) => {
  for (let i = 0; i < 50; i++) {
    const rows = await Notification.find({ userId, type: TOPUP_NEEDED }).lean()
    if (rows.length) return rows
    await new Promise((r) => setTimeout(r, 20))
  }
  return []
}

/** Chuyển dự án sang cho một Analyst của cùng tổ chức — như thể Analyst tạo ra nó. */
const handToAnalyst = async (orgId: string, projectId: string) => {
  const analyst = await User.create({ email: "analyst-" + Date.now() + "@flintflow.test", password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: analyst._id, role: "analyst" })
  await Project.updateOne({ _id: projectId }, { $set: { userId: analyst._id } })
  return String(analyst._id)
}

describe("Flow 4 mode 1 theo tổ chức", () => {
  it("4.2: dự án của Analyst hết credit ⇒ Lead nhận thông báo nạp, Analyst thì không", async () => {
    const { c, seeded, projectId } = await importedProject()
    const analystId = await handToAnalyst(seeded.orgId, projectId)
    const { cr } = await crToImpact(c)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 0 } })

    expect(detail(await c.post(`${cr}/propose`)).change_request.paused?.reason).toBe("credits")

    const [notice] = await waitForNotices(seeded.userId)
    expect(notice).toMatchObject({ link: "/home/billing", meta: { project_id: projectId } })
    expect(String(notice?.organizationId)).toBe(seeded.orgId)
    expect(await Notification.countDocuments({ userId: analystId, type: TOPUP_NEEDED })).toBe(0)
  })

  it("4.5 ⇒ 4.1: Lead nạp vào ví tổ chức ⇒ bước dừng trong dự án của Analyst cũng chạy tiếp", async () => {
    const { c, seeded, projectId } = await importedProject()
    await handToAnalyst(seeded.orgId, projectId)
    const { crId } = await crToImpact(c)
    const cr = await crDoc(projectId, crId)
    await ChangeRequest.updateOne({ _id: cr._id }, { $set: { status: "proposing", paused: { reason: "credits", at: new Date() } } })
    const deps = () => ({ resumeExtraction: vi.fn(), resumeCheck: vi.fn(), resumeCr: vi.fn(async () => undefined) })

    // Cách cũ (theo người nạp): dự án không phải của Lead ⇒ bị bỏ sót
    expect(await resumeAfterTopUp(seeded.userId, deps())).toBe(0)

    // Theo tổ chức: thấy và chạy tiếp
    const byOrg = deps()
    expect(await resumeAfterTopUp(seeded.userId, byOrg, seeded.orgId)).toBe(1)
    expect(byOrg.resumeCr).toHaveBeenCalledWith(projectId, crId, seeded.userId)
  })
})
