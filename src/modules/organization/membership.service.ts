import mongoose from "mongoose"
import { Membership, ORG_ROLES, type OrgRole } from "./membership.model.js"
import { Organization } from "./organization.model.js"
import { assertLeadRemains, touchMembership } from "./lead-succession.js"
import { User } from "../user/user.model.js"
import { planConfig } from "../billing/plan.config.js"
import { notify } from "../notification/notification.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { runInTransaction, TRANSACTION_UNAVAILABLE, sessionOptions } from "../../shared/db/transaction.js"

export interface MemberItem {
  userId: string
  email: string
  name?: string
  role: OrgRole
  joinedAt: Date
}

const notFound = () => new ApiError(404, "Không tìm thấy thành viên trong tổ chức", "MEMBER_NOT_FOUND")

const assertObjectId = (id: string) => {
  if (!mongoose.isValidObjectId(id)) throw notFound()
}

/** UC-73 (phần xem): danh sách thành viên kèm email / tên để Lead thao tác. */
export const listMembers = async (orgId: string): Promise<MemberItem[]> => {
  const memberships = await Membership.find({ organizationId: orgId }).sort({ joinedAt: 1 }).lean()
  if (memberships.length === 0) return []

  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } })
    .select("_id email name")
    .lean()
  const byId = new Map(users.map((u) => [String(u._id), u]))

  return memberships.map((m) => {
    const user = byId.get(String(m.userId))
    return {
      userId: String(m.userId),
      email: user?.email ?? "(tài khoản đã xoá)",
      ...(user?.name ? { name: user.name } : {}),
      role: m.role,
      joinedAt: m.joinedAt
    }
  })
}

/**
 * Trần số thành viên theo gói. Gọi trước khi thêm người (mã mời ở Pha 3); tách ra đây để chỗ nào thêm
 * thành viên cũng đi qua đúng một luật.
 */
export const assertMemberQuota = async (orgId: string, plan: keyof typeof planConfig = "free"): Promise<void> => {
  const definition = plan === "pro" ? planConfig.pro : planConfig.free
  const count = await Membership.countDocuments({ organizationId: orgId })
  if (count >= definition.maxMembers) {
    throw new ApiError(
      402,
      `Gói ${definition.label} chỉ cho tối đa ${definition.maxMembers} thành viên`,
      "PLAN_LIMIT_MEMBERS"
    )
  }
}

const orgName = async (orgId: string): Promise<string> => {
  const org = await Organization.findById(orgId).select("name").lean()
  return org?.name ?? "tổ chức"
}

/** Ba thao tác dưới đây dùng chung một khung: serialize theo org → kiểm BR-02 → ghi. */
const runMembershipChange = async <T>(
  orgId: string,
  write: (session?: mongoose.ClientSession) => Promise<T>
): Promise<T> => {
  const body = async (session?: mongoose.ClientSession) => {
    await touchMembership(orgId, session)
    return write(session)
  }
  const result = await runInTransaction(body)
  // Mongo standalone (dev): không có transaction nên không serialize được — vẫn kiểm BR-02, chỉ là
  // không chống được hai request đồng thời. Production chạy replica set nên đi nhánh trên.
  return result === TRANSACTION_UNAVAILABLE ? await body() : result
}

/** UC-73 / Flow 9.5: đổi vai trò một thành viên. BR-02 chặn việc hạ Lead cuối cùng. */
export const changeMemberRole = async (
  orgId: string,
  targetUserId: string,
  nextRole: OrgRole
): Promise<MemberItem> => {
  assertObjectId(targetUserId)
  if (!ORG_ROLES.includes(nextRole)) {
    throw new ApiError(400, "Vai trò không hợp lệ", "VALIDATION_ERROR")
  }

  await runMembershipChange(orgId, async (session) => {
    await assertLeadRemains(orgId, targetUserId, nextRole, session)
    const updated = await Membership.findOneAndUpdate(
      { organizationId: orgId, userId: targetUserId },
      { role: nextRole },
      { ...sessionOptions(session), new: true }
    )
    if (!updated) throw notFound()
  })

  void notify(targetUserId, {
    type: "org_role_changed",
    title: "Vai trò của bạn đã thay đổi",
    body: `Bạn giờ là ${nextRole} trong ${await orgName(orgId)}.`,
    organizationId: orgId,
    meta: { organizationId: orgId, role: nextRole }
  })

  const members = await listMembers(orgId)
  const member = members.find((m) => m.userId === targetUserId)
  if (!member) throw notFound()
  return member
}

/** UC-74 / Flow 9.6: Lead xoá một thành viên khỏi org. */
export const removeMember = async (orgId: string, targetUserId: string): Promise<{ removed: true }> => {
  assertObjectId(targetUserId)

  await runMembershipChange(orgId, async (session) => {
    await assertLeadRemains(orgId, targetUserId, null, session)
    const deleted = await Membership.findOneAndDelete(
      { organizationId: orgId, userId: targetUserId },
      sessionOptions(session)
    )
    if (!deleted) throw notFound()
  })

  void notify(targetUserId, {
    type: "org_member_removed",
    title: "Bạn đã bị xoá khỏi tổ chức",
    body: `Bạn không còn là thành viên của ${await orgName(orgId)}.`,
    organizationId: orgId,
    meta: { organizationId: orgId }
  })

  return { removed: true }
}

/** UC-72 / Flow 9.7: tự rời org. Dự án ở lại với org. */
export const leaveOrganization = async (orgId: string, userId: string): Promise<{ left: true }> => {
  await runMembershipChange(orgId, async (session) => {
    await assertLeadRemains(orgId, userId, null, session)
    const deleted = await Membership.findOneAndDelete(
      { organizationId: orgId, userId },
      sessionOptions(session)
    )
    if (!deleted) throw notFound()
  })

  // Flow SD-3.3-5: Lead cần biết đội hình đổi.
  const [leads, name, user] = await Promise.all([
    Membership.find({ organizationId: orgId, role: "lead" }).select("userId").lean(),
    orgName(orgId),
    User.findById(userId).select("email name").lean()
  ])
  const who = user?.name || user?.email || "Một thành viên"
  for (const lead of leads) {
    void notify(String(lead.userId), {
      type: "org_member_left",
      title: "Một thành viên đã rời tổ chức",
      body: `${who} đã rời ${name}.`,
      organizationId: orgId,
      meta: { organizationId: orgId, userId }
    })
  }

  return { left: true }
}
