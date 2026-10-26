/**
 * topup-request.service.ts — Analyst báo Lead nạp credit (FLF-332, BR-08).
 * ─────────────────────────────────────────────────────────────────
 * `requestTopup`: tạo (hoặc cập nhật) yêu cầu `open` của (org, user), báo in-app cho mọi Lead của org
 * (`credit_topup_requested`). Lead tự báo chính mình thì chỉ ghi yêu cầu, không tự nhận thông báo.
 * `fulfillTopupRequests`: gọi sau khi ví org được nạp (webhook thanh toán thành công, admin cộng credit) — đóng mọi
 * yêu cầu `open` của org và báo từng người đã yêu cầu (`credit_topped_up`). Step **không tự chạy**: thông báo chỉ dẫn
 * người dùng bấm tiếp tục (BR-08). Là side effect: lỗi chỉ log, không làm hỏng luồng nạp.
 */

import mongoose from "mongoose"
import { Membership } from "../organization/membership.model.js"
import { Organization } from "../organization/organization.model.js"
import { Project } from "../project/project.model.js"
import { User } from "../user/user.model.js"
import { notify } from "../notification/notification.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { CreditTopupRequest, type ICreditTopupRequest } from "./credit-topup-request.model.js"

export interface TopupRequestInput {
  projectId?: string | null
  step?: string | null
  needed?: number | null
}

export interface TopupRequestDto {
  id: string
  organization_id: string
  user_id: string
  project_id: string | null
  step: string | null
  needed: number | null
  status: "open" | "fulfilled"
  /** Số Lead đã được báo (0 khi chính Lead tự báo). */
  notified_leads: number
  available: number
  created_at: string
  fulfilled_at: string | null
}

const toDto = (doc: ICreditTopupRequest, notifiedLeads: number, available: number): TopupRequestDto => ({
  id: String(doc._id),
  organization_id: String(doc.organizationId),
  user_id: String(doc.userId),
  project_id: doc.projectId ? String(doc.projectId) : null,
  step: doc.step ?? null,
  needed: doc.needed ?? null,
  status: doc.status,
  notified_leads: notifiedLeads,
  available,
  created_at: doc.createdAt.toISOString(),
  fulfilled_at: doc.fulfilledAt ? doc.fulfilledAt.toISOString() : null
})

const availableOf = async (orgId: string): Promise<number> => {
  const wallet = await CreditWallet.findOne({ organizationId: orgId }).lean()
  return wallet ? wallet.balance - wallet.reserved : 0
}

export const requestTopup = async (orgId: string, userId: string, input: TopupRequestInput = {}): Promise<TopupRequestDto> => {
  const projectId = input.projectId && mongoose.isValidObjectId(input.projectId) ? input.projectId : null
  // Một yêu cầu mở mỗi người mỗi org: bấm lại chỉ cập nhật step / số cần, Lead không bị dội thông báo trùng
  const existing = await CreditTopupRequest.findOne({ organizationId: orgId, userId, status: "open" })
  const doc =
    existing ??
    (await CreditTopupRequest.create({ organizationId: orgId, userId, projectId, step: input.step ?? null, needed: input.needed ?? null, status: "open" }))
  if (existing) {
    existing.projectId = projectId ? new mongoose.Types.ObjectId(projectId) : existing.projectId
    existing.step = input.step ?? existing.step
    existing.needed = input.needed ?? existing.needed
    await existing.save()
  }

  const [requester, org, project, leads, available] = await Promise.all([
    User.findById(userId).select("name email").lean(),
    Organization.findById(orgId).select("name").lean(),
    projectId ? Project.findById(projectId).select("name").lean() : null,
    Membership.find({ organizationId: orgId, role: "lead", userId: { $ne: userId } }).select("userId").lean(),
    availableOf(orgId)
  ])
  const who = requester?.name || requester?.email || "Một thành viên"
  const where = project ? ` ở dự án "${project.name}"` : ""
  const step = input.step ? ` (bước ${input.step})` : ""
  const needed = input.needed ? `, cần thêm khoảng ${input.needed} credit` : ""

  if (!existing) {
    await Promise.all(
      leads.map((m) =>
        notify(String(m.userId), {
          type: "credit_topup_requested",
          title: `${who} cần nạp credit cho ${org?.name ?? "tổ chức"}`,
          body: `Ví tổ chức còn ${available} credit khả dụng${where}${step}${needed}. Nạp thêm để bước AI chạy tiếp.`,
          link: "/home/billing",
          organizationId: orgId,
          meta: { organizationId: orgId, requestedBy: userId, projectId, step: input.step ?? null, needed: input.needed ?? null, available }
        })
      )
    )
  }
  return toDto(doc, existing ? 0 : leads.length, available)
}

/** Ví org vừa được nạp `credits` ⇒ đóng yêu cầu mở, báo người đã yêu cầu. Trả số yêu cầu đã đóng. */
export const fulfillTopupRequests = async (orgId: string, credits: number, by: { kind: "payment" | "admin"; userId?: string | null }): Promise<number> => {
  if (!mongoose.isValidObjectId(orgId) || credits <= 0) return 0
  try {
    const open = await CreditTopupRequest.find({ organizationId: orgId, status: "open" })
    if (open.length === 0) return 0
    const now = new Date()
    await CreditTopupRequest.updateMany({ _id: { $in: open.map((r) => r._id) } }, { $set: { status: "fulfilled", fulfilledAt: now, fulfilledCredits: credits } })
    const available = await availableOf(orgId)
    await Promise.all(
      open
        .filter((r) => String(r.userId) !== (by.userId ?? ""))
        .map((r) =>
          notify(String(r.userId), {
            type: "credit_topped_up",
            title: `Tổ chức đã được nạp ${credits} credit`,
            body: `${by.kind === "admin" ? "Quản trị viên" : "Lead"} đã nạp ${credits} credit, ví còn ${available} credit khả dụng. Mở lại dự án và bấm tiếp tục — bước đang dừng không tự chạy.`,
            link: r.projectId ? `/projects/${String(r.projectId)}` : "/home/billing",
            organizationId: orgId,
            meta: { organizationId: orgId, credits, available, projectId: r.projectId ? String(r.projectId) : null, step: r.step ?? null }
          })
        )
    )
    return open.length
  } catch (err) {
    console.warn("[billing] không đóng được yêu cầu nạp credit sau khi nạp:", err)
    return 0
  }
}
