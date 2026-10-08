import mongoose from "mongoose"
import { Organization, ORG_NAME_MAX, type IOrganization } from "./organization.model.js"
import { Membership, type OrgRole } from "./membership.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { runInTransaction, TRANSACTION_UNAVAILABLE, sessionOptions } from "../../shared/db/transaction.js"
import * as sessionService from "../../shared/auth/session.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { Subscription } from "../credits/subscription.model.js"
import { planConfig } from "../billing/plan.config.js"
import { markOnboarded } from "./onboarding.js"
import { Invitation } from "./invitation.model.js"
import { Project } from "../project/project.model.js"
import { deleteProject } from "../project/project.service.js"
import { Folder } from "../folder/folder.model.js"
import { Notification } from "../notification/notification.model.js"
import { PaymentIntent } from "../billing/payment-intent.model.js"
import { Session } from "../../shared/auth/session.model.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"

/** Org kèm vai trò của người đang hỏi — đủ cho màn chọn org (Flow 7.13, 9.3). */
export interface OrganizationSummary {
  id: string
  name: string
  role: OrgRole
  joinedAt: Date
}

const notFound = () => new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")

const assertObjectId = (id: string) => {
  if (!mongoose.isValidObjectId(id)) throw notFound()
}

const toSummary = (org: Pick<IOrganization, "_id" | "name">, role: OrgRole, joinedAt: Date): OrganizationSummary => ({
  id: String(org._id),
  name: org.name,
  role,
  joinedAt
})

/**
 * Ví credit + gói free của org (BPMN Flow 8.2 "open the wallet"). Một ví cho cả org — partial unique index
 * trên `organizationId` giữ điều đó. `userId` ghi kèm chỉ để biết ví sinh ra từ tài khoản nào.
 */
const openWallet = async (orgId: string, userId: string, session?: mongoose.ClientSession): Promise<void> => {
  const now = new Date()
  await CreditWallet.create(
    [{ organizationId: orgId, userId, balance: planConfig.free.initialCredits, reserved: 0 }],
    sessionOptions(session)
  )
  await Subscription.create(
    [
      {
        organizationId: orgId,
        userId,
        plan: "free",
        status: "active",
        monthlyCreditsAllotment: planConfig.free.monthlyCredits,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + planConfig.periodDays * 86_400_000)
      }
    ],
    sessionOptions(session)
  )
}

/**
 * UC-07 / BPMN Flow 8.1–8.2: tạo org ở gói free, người tạo thành Lead đầu tiên.
 *
 * Org + Membership phải cùng sống hoặc cùng chết: một org không có Lead nào là trạng thái mà BR-02 cấm,
 * nên tạo hai bản ghi trong một transaction. Mongo standalone (dev) không có transaction ⇒ tạo tuần tự
 * và tự dọn org nếu bước Membership hỏng.
 *
 * Mở luôn ví credit và gói free của org ("open the wallet" trong Flow 8.2). Cả bốn bản ghi nằm trong một
 * transaction: org không Lead, hoặc org không ví, đều là trạng thái nửa vời mà phần còn lại của hệ thống
 * không lường trước.
 */
export const createOrganization = async (userId: string, name: string): Promise<OrganizationSummary> => {
  const create = async (session?: mongoose.ClientSession) => {
    const [org] = await Organization.create([{ name, ownerUserId: userId }], sessionOptions(session))
    if (!org) throw new ApiError(500, "Không tạo được tổ chức", "ORG_CREATE_FAILED")
    const joinedAt = new Date()
    await Membership.create([{ organizationId: org._id, userId, role: "lead", joinedAt }], sessionOptions(session))
    await openWallet(String(org._id), userId, session)
    return toSummary(org, "lead", joinedAt)
  }

  const result = await runInTransaction(create)
  if (result !== TRANSACTION_UNAVAILABLE) {
    await markOnboarded(userId)
    return result
  }

  const org = await Organization.create({ name, ownerUserId: userId })
  try {
    const joinedAt = new Date()
    await Membership.create({ organizationId: org._id, userId, role: "lead", joinedAt })
    await openWallet(String(org._id), userId)
    await markOnboarded(userId)
    return toSummary(org, "lead", joinedAt)
  } catch (err) {
    await Membership.deleteOne({ organizationId: org._id, userId })
    await Organization.deleteOne({ _id: org._id })
    throw err
  }
}

/** Danh sách org của một người kèm vai trò từng org (UC-10). */
export const listMyOrganizations = async (userId: string): Promise<OrganizationSummary[]> => {
  const memberships = await Membership.find({ userId }).sort({ joinedAt: 1 }).lean()
  if (memberships.length === 0) return []

  const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.organizationId) } })
    .select("_id name")
    .lean()
  const byId = new Map(orgs.map((o) => [String(o._id), o]))

  return memberships
    .map((m) => {
      const org = byId.get(String(m.organizationId))
      return org ? toSummary(org, m.role, m.joinedAt) : null
    })
    .filter((item): item is OrganizationSummary => item !== null)
}

/** Một org cụ thể — người gọi phải là thành viên (guard ở route đã bảo đảm). */
export const getOrganization = async (orgId: string, role: OrgRole): Promise<OrganizationSummary & { memberCount: number }> => {
  assertObjectId(orgId)
  const org = await Organization.findById(orgId).select("_id name").lean()
  if (!org) throw notFound()
  const [membership, memberCount] = await Promise.all([
    Membership.findOne({ organizationId: orgId }).select("joinedAt").lean(),
    Membership.countDocuments({ organizationId: orgId })
  ])
  return { ...toSummary(org, role, membership?.joinedAt ?? new Date()), memberCount }
}

/** Đổi tên org — chỉ Lead (guard ở route). */
export const renameOrganization = async (orgId: string, name: string, role: OrgRole): Promise<OrganizationSummary> => {
  assertObjectId(orgId)
  if (name.trim().length === 0 || name.length > ORG_NAME_MAX) {
    throw new ApiError(400, "Tên tổ chức không hợp lệ", "VALIDATION_ERROR")
  }
  const org = await Organization.findByIdAndUpdate(orgId, { name: name.trim() }, { new: true }).select("_id name").lean()
  if (!org) throw notFound()
  return toSummary(org, role, new Date())
}

export interface SwitchResult {
  accessToken: string
  organization: OrganizationSummary
}

/**
 * UC-10 / BPMN Flow 9.3–9.4: chọn org khác để làm việc.
 *
 * Ghi `activeOrgId` vào chính phiên đang dùng (tìm qua refresh token) rồi cấp access token mới mang
 * `orgId` mới — từ đó `orgContext` nạp đúng vai trò của org đó. Mỗi thiết bị có phiên riêng nên đổi org
 * ở máy này không kéo theo máy khác.
 */
export const switchOrganization = async (
  userId: string,
  email: string,
  platformRole: string | undefined,
  orgId: string,
  refreshToken?: string
): Promise<SwitchResult> => {
  assertObjectId(orgId)
  const membership = await Membership.findOne({ organizationId: orgId, userId }).lean()
  if (!membership) throw notFound()

  const org = await Organization.findById(orgId).select("_id name").lean()
  if (!org) throw notFound()

  if (refreshToken) await sessionService.setActiveOrg(refreshToken, orgId)

  return {
    accessToken: signAccessToken({
      userId,
      email,
      ...(platformRole ? { role: platformRole } : {}),
      orgId
    }),
    organization: toSummary(org, membership.role, membership.joinedAt)
  }
}

export interface DeleteOrganizationResult {
  deleted: true
  projectsDeleted: number
}

/**
 * Xoá tổ chức — chỉ khi Lead là thành viên DUY NHẤT (không cướp dữ liệu của người khác, và BR-02 không
 * còn ý nghĩa khi org biến mất). Không có trong actors-and-use-cases.md; thêm theo yêu cầu 2026-09-26.
 *
 * Xoá sạch dự án (kể cả đã lưu trữ, qua `deleteProject(..., hard)` — cùng đường dọn Spine, tài liệu, sơ đồ
 * như xoá một dự án), thư mục, ví, gói, mã mời, thông báo. GIỮ LẠI sổ giao dịch credit và PaymentIntent:
 * đó là hồ sơ tài chính, admin còn cần đối soát.
 *
 * Người gọi phải gõ lại đúng tên org — thao tác không khôi phục được.
 */
export const deleteOrganization = async (
  orgId: string,
  userId: string,
  confirmName: string
): Promise<DeleteOrganizationResult> => {
  assertObjectId(orgId)
  const org = await Organization.findById(orgId).select("_id name").lean()
  if (!org) throw notFound()

  if (confirmName.trim() !== org.name) {
    throw new ApiError(400, "Tên xác nhận không khớp với tên tổ chức", "ORG_NAME_MISMATCH")
  }

  // Chặn mã mời TRƯỚC khi đếm thành viên: không ai vào thêm được giữa lúc đang xoá.
  await Invitation.deleteMany({ organizationId: orgId })

  const members = await Membership.find({ organizationId: orgId }).select("userId role").lean()
  const onlyMe = members.length === 1 && String(members[0]?.userId) === userId && members[0]?.role === "lead"
  if (!onlyMe) {
    throw new ApiError(
      409,
      "Chỉ xoá được tổ chức khi bạn là thành viên duy nhất — hãy xoá các thành viên khác trước",
      "ORG_HAS_OTHER_MEMBERS"
    )
  }

  const wallet = await CreditWallet.findOne({ organizationId: orgId }).select("reserved").lean()
  if (wallet && wallet.reserved > 0) {
    throw new ApiError(409, "Tổ chức đang có lượt gọi AI chạy dở — thử lại sau ít phút", "ORG_BUSY")
  }
  if (await PaymentIntent.exists({ organizationId: orgId, status: "pending" })) {
    // Webhook về sau sẽ cộng credit vào ví của một org đã biến mất.
    throw new ApiError(409, "Tổ chức đang có thanh toán chờ xử lý — thử lại khi thanh toán kết thúc", "ORG_PAYMENT_PENDING")
  }

  const projects = await Project.find({ organizationId: orgId }).select("_id").lean()
  for (const project of projects) {
    await deleteProject(String(project._id), orgId, true)
  }

  await Promise.all([
    Folder.deleteMany({ organizationId: orgId }),
    CreditWallet.deleteMany({ organizationId: orgId }),
    Subscription.deleteMany({ organizationId: orgId }),
    Notification.deleteMany({ organizationId: orgId }),
    // Phiên đang mở org này: bỏ org đang mở để lượt refresh sau không cấp lại token trỏ vào org đã xoá.
    Session.updateMany({ activeOrgId: orgId }, { $set: { activeOrgId: null } })
  ])
  await Membership.deleteMany({ organizationId: orgId })
  await Organization.deleteOne({ _id: orgId })

  return { deleted: true, projectsDeleted: projects.length }
}
