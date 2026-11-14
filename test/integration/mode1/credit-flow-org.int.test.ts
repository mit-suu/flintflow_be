/**
 * task-26 × Flow 4 mode 1 — ví là của TỔ CHỨC và chỉ Lead được nạp (BR-01, BR-08):
 * - 4.2: hết credit ⇒ báo Lead của tổ chức (hướng dẫn mở lại dự án và bấm tiếp tục), không báo Analyst.
 * - nạp xong ⇒ KHÔNG tự chạy lại; Analyst có CR đang dừng nhận `credit_topped_up` và tự gọi `/resume` để chạy tiếp.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { authAs } from "../../setup.js"
import { mode1Api } from "../../helpers/mode1.js"
import { crToImpact, crDoc, detail, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { TOPUP_NEEDED } from "../../../src/modules/import/credit-flow.service.js"
import { fulfillTopupRequests } from "../../../src/modules/billing/topup-request.service.js"

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
  const email = "analyst-" + Date.now() + "@flintflow.test"
  const analyst = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: analyst._id, role: "analyst" })
  await Project.updateOne({ _id: projectId }, { $set: { userId: analyst._id } })
  const token = await authAs({ _id: analyst._id, email, orgId })
  return { id: String(analyst._id), token }
}

describe("Flow 4 mode 1 theo tổ chức", () => {
  it("4.2: dự án của Analyst hết credit ⇒ Lead nhận thông báo nạp (không tự chạy lại), Analyst thì không", async () => {
    const { c, seeded, projectId } = await importedProject()
    const analyst = await handToAnalyst(seeded.orgId, projectId)
    const { cr } = await crToImpact(c)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 0 } })

    expect(detail(await c.post(`${cr}/propose`)).change_request.paused?.reason).toBe("credits")

    const [notice] = await waitForNotices(seeded.userId)
    expect(notice).toMatchObject({ link: "/home/billing", meta: { project_id: projectId } })
    expect(notice.body).not.toContain("tự chạy lại")
    expect(notice.body).toContain("mở lại dự án và bấm tiếp tục")
    expect(String(notice?.organizationId)).toBe(seeded.orgId)
    expect(await Notification.countDocuments({ userId: analyst.id, type: TOPUP_NEEDED })).toBe(0)
  })

  it("Lead nạp vào ví tổ chức ⇒ CR của Analyst giữ nguyên paused credits, Analyst nhận credit_topped_up và tự gọi POST /change-requests/:crId/resume", async () => {
    const { seeded, projectId } = await importedProject()
    const analyst = await handToAnalyst(seeded.orgId, projectId)
    const analystApi = mode1Api({ ...seeded, userId: analyst.id, token: analyst.token }, projectId)
    const { cr, crId } = await crToImpact(analystApi)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 0 } })

    expect(detail(await analystApi.post(`${cr}/propose`)).change_request.paused?.reason).toBe("credits")

    // Nạp ví + thông báo: CR KHÔNG tự chạy lại, Analyst nhận thông báo, Lead đang nạp không tự nhận
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 1000 } })
    expect(await fulfillTopupRequests(seeded.orgId, 1000, { kind: "payment", userId: seeded.userId })).toBe(1)

    const pausedCr = await crDoc(projectId, crId)
    expect(pausedCr.paused?.reason).toBe("credits")
    expect(pausedCr.status).toBe("proposing")

    const analystNotices = await Notification.find({ userId: analyst.id, type: "credit_topped_up" }).lean()
    expect(analystNotices).toHaveLength(1)
    expect(String(analystNotices[0].organizationId)).toBe(seeded.orgId)
    expect(analystNotices[0].body).toContain("bấm tiếp tục")
    expect(analystNotices[0].link).toBe(`/projects/${projectId}`)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topped_up" })).toBe(0)

    // Analyst tự gọi POST /change-requests/:crId/resume ⇒ chạy tiếp và đề xuất xong mọi vị trí
    const resumed = detail(await analystApi.post(`${cr}/resume`))
    expect(resumed.change_request.paused).toBeNull()
    expect(resumed.change_request.status).toBe("proposing")
    expect(resumed.locations.every((l) => l.conclusion !== null)).toBe(true)
  })
})
