import { describe, it, expect, beforeEach, vi } from "vitest"

const users = new Map<string, Record<string, unknown>>()

vi.mock("./notification.model.js", () => ({
  Notification: { create: vi.fn(async (doc: Record<string, unknown>) => ({ _id: "n1", ...doc })) }
}))
vi.mock("../user/user.model.js", () => ({
  User: {
    findById: (id: string) => ({ select: () => ({ lean: async () => users.get(String(id)) ?? null }) })
  }
}))
vi.mock("../../shared/email/email.service.js", () => ({ sendApprovalEmail: vi.fn(async () => undefined) }))

import { notify } from "./notification.service.js"
import { sendApprovalEmail } from "../../shared/email/email.service.js"

const LEAD = "64b000000000000000000020"

/** `notify` gửi email không chờ (void) ⇒ đợi các promise vi mô chạy xong rồi mới kiểm. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const submitted = {
  type: "baseline_submitted",
  title: "Shop chờ bạn duyệt baseline",
  body: "Tài liệu đã qua kiểm tra, không còn cờ đỏ.",
  link: "/projects/p1",
  organizationId: "64b000000000000000000099"
}

describe("UC-89 email việc duyệt kèm notify", () => {
  beforeEach(() => {
    users.clear()
    vi.mocked(sendApprovalEmail).mockClear()
  })

  it("thông báo việc duyệt ⇒ gửi email cùng tiêu đề, nội dung, link tuyệt đối", async () => {
    users.set(LEAD, { email: "lead@x.io", name: "Lan", approvalEmails: true, isActive: true })
    await notify(LEAD, submitted)
    await settle()
    expect(sendApprovalEmail).toHaveBeenCalledTimes(1)
    const [to, input] = vi.mocked(sendApprovalEmail).mock.calls[0]
    expect(to).toBe("lead@x.io")
    expect(input).toMatchObject({ name: "Lan", title: submitted.title, body: submitted.body })
    expect(input.url).toMatch(/^https?:\/\/.+\/projects\/p1$/)
  })

  it("tài khoản cũ chưa có field (undefined) ⇒ coi như bật", async () => {
    users.set(LEAD, { email: "lead@x.io" })
    await notify(LEAD, { ...submitted, type: "review_package_released" })
    await settle()
    expect(sendApprovalEmail).toHaveBeenCalledTimes(1)
  })

  it("người đã tắt email việc duyệt ⇒ không gửi email, vẫn có thông báo trong app", async () => {
    users.set(LEAD, { email: "lead@x.io", approvalEmails: false })
    const created = await notify(LEAD, submitted)
    await settle()
    expect(created).not.toBeNull()
    expect(sendApprovalEmail).not.toHaveBeenCalled()
  })

  it("thông báo khác (thanh toán) ⇒ không gửi email việc duyệt", async () => {
    users.set(LEAD, { email: "lead@x.io", approvalEmails: true })
    await notify(LEAD, { type: "payment_success", title: "OK", body: "Đã cộng credit" })
    await settle()
    expect(sendApprovalEmail).not.toHaveBeenCalled()
  })

  it("email lỗi không làm hỏng notify", async () => {
    users.set(LEAD, { email: "lead@x.io", approvalEmails: true })
    vi.mocked(sendApprovalEmail).mockRejectedValueOnce(new Error("smtp down"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(notify(LEAD, submitted)).resolves.not.toBeNull()
    await settle()
    spy.mockRestore()
  })
})
