import crypto from "node:crypto"
import mongoose from "mongoose"
import { Invitation, INVITABLE_ROLES, type InvitableRole } from "./invitation.model.js"
import { Membership } from "./membership.model.js"
import { Organization } from "./organization.model.js"
import { assertMemberQuota } from "./membership.service.js"
import { markOnboarded } from "./onboarding.js"
import { User } from "../user/user.model.js"
import { notify } from "../notification/notification.service.js"
import { sendOrgInvitationEmail } from "../../shared/email/email.service.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { runInTransaction, TRANSACTION_UNAVAILABLE, sessionOptions } from "../../shared/db/transaction.js"
import { env } from "../../config/env.js"

/**
 * Bảng chữ mã mời: bỏ 0/O/1/I/L để người đọc từ email gõ lại không nhầm. 31 ký tự, 10 vị trí ≈ 49 bit —
 * thừa sức cho một mã sống 7 ngày, dùng một lần, và tra bằng hash có index duy nhất.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

export const ROLE_LABELS: Record<InvitableRole, string> = {
  analyst: "Analyst",
  viewer: "Viewer"
}

/** Người dùng gõ tay nên chấp nhận chữ thường, khoảng trắng và gạch nối. */
export const normalizeCode = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase()

export const hashCode = (code: string): string =>
  crypto.createHash("sha256").update(normalizeCode(code)).digest("hex")

export const generateCode = (length: number = env.INVITE_CODE_LENGTH): string => {
  let out = ""
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)]
  }
  return out
}

export type InvitationState = "pending" | "accepted" | "revoked" | "expired"

/** Trạng thái là giá trị SUY DIỄN từ ba mốc thời gian — model cố tình không có field status. */
export const invitationState = (
  invitation: { acceptedAt?: Date | null; revokedAt?: Date | null; expiresAt: Date },
  now: Date = new Date()
): InvitationState => {
  if (invitation.revokedAt) return "revoked"
  if (invitation.acceptedAt) return "accepted"
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired"
  return "pending"
}

export interface InvitationItem {
  id: string
  email: string | null
  role: InvitableRole
  state: InvitationState
  expiresAt: Date
  createdAt: Date
}

const toItem = (invitation: {
  _id: unknown
  email: string | null
  role: InvitableRole
  acceptedAt?: Date | null
  revokedAt?: Date | null
  expiresAt: Date
  createdAt: Date
}): InvitationItem => ({
  id: String(invitation._id),
  email: invitation.email,
  role: invitation.role,
  state: invitationState(invitation),
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt
})

const invalidCode = () =>
  new ApiError(410, "Mã mời không dùng được: đã hết hạn, đã dùng hoặc đã bị thu hồi", "INVITE_INVALID")

export interface CreatedInvitation extends InvitationItem {
  /** Mã thô — CHỈ trả đúng lượt tạo này. DB chỉ giữ hash, nên mất là phải thu hồi và mời lại. */
  code: string
}

/**
 * UC-08 / BPMN Flow 9.1–9.2: Lead sinh mã mời có hạn kèm vai trò, Email Service gửi cho người được mời.
 *
 * Vai trò chỉ nhận Analyst / Viewer: muốn thêm Lead thì mời trước rồi nâng bằng UC-73, để việc tạo Lead
 * luôn là hành động có chủ đích của một Lead đang có chứ không phải hệ quả của mã phát đi từ lâu.
 */
export const createInvitation = async (
  orgId: string,
  inviterUserId: string,
  role: InvitableRole,
  email?: string
): Promise<CreatedInvitation> => {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new ApiError(400, "Chỉ mời được với vai trò Analyst hoặc Viewer", "VALIDATION_ERROR")
  }
  await assertMemberQuota(orgId)

  const code = generateCode()
  const expiresAt = new Date(Date.now() + env.INVITE_TTL_DAYS * 86_400_000)
  const invitation = await Invitation.create({
    organizationId: orgId,
    email: email ?? null,
    role,
    codeHash: hashCode(code),
    expiresAt,
    invitedByUserId: inviterUserId
  })

  if (email) {
    const [org, inviter] = await Promise.all([
      Organization.findById(orgId).select("name").lean(),
      User.findById(inviterUserId).select("name email").lean()
    ])
    // Gửi mail là side effect: hỏng SMTP không được làm hỏng việc tạo mã (Lead vẫn đọc được mã ở response).
    void sendOrgInvitationEmail(email, {
      code,
      organizationName: org?.name ?? "FlintFlow",
      roleLabel: ROLE_LABELS[role],
      inviterName: inviter?.name || inviter?.email || "Một thành viên",
      expiresInDays: env.INVITE_TTL_DAYS
    })
  }

  return { ...toItem(invitation), code }
}

/** UC-08 (phần xem): mã đang treo của org, mới nhất trước. Không bao giờ trả mã thô. */
export const listInvitations = async (orgId: string): Promise<InvitationItem[]> => {
  const invitations = await Invitation.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean()
  return invitations.map(toItem)
}

/** UC-08: Lead thu hồi một mã CHƯA dùng. Mã đã dùng thì không thu hồi được — người kia đã vào org rồi. */
export const revokeInvitation = async (orgId: string, invitationId: string): Promise<InvitationItem> => {
  if (!mongoose.isValidObjectId(invitationId)) {
    throw new ApiError(404, "Không tìm thấy lời mời", "INVITE_NOT_FOUND")
  }
  const invitation = await Invitation.findOne({ _id: invitationId, organizationId: orgId })
  if (!invitation) throw new ApiError(404, "Không tìm thấy lời mời", "INVITE_NOT_FOUND")

  const state = invitationState(invitation)
  if (state === "accepted") {
    throw new ApiError(409, "Mã đã được dùng — hãy xoá thành viên nếu muốn thu hồi quyền", "INVITE_ALREADY_USED")
  }
  if (state !== "revoked") {
    invitation.revokedAt = new Date()
    await invitation.save()
  }
  return toItem(invitation)
}

export interface InvitationPreview {
  organizationName: string
  role: InvitableRole
  roleLabel: string
  expiresAt: Date
}

/** Xem trước trước khi bấm tham gia (Flow 8.3). Mã hỏng thì 410 luôn, không lộ gì thêm. */
export const previewInvitation = async (code: string): Promise<InvitationPreview> => {
  const invitation = await Invitation.findOne({ codeHash: hashCode(code) }).lean()
  if (!invitation || invitationState(invitation) !== "pending") throw invalidCode()

  const org = await Organization.findById(invitation.organizationId).select("name").lean()
  if (!org) throw invalidCode()

  return {
    organizationName: org.name,
    role: invitation.role,
    roleLabel: ROLE_LABELS[invitation.role],
    expiresAt: invitation.expiresAt
  }
}

export interface AcceptResult {
  organization: { id: string; name: string; role: InvitableRole }
  /** Token mới mang orgId vừa vào — người dùng làm việc ngay, không phải gọi thêm /switch. */
  accessToken: string
}

/**
 * UC-09 / BPMN Flow 8.3–8.5: nhập mã mời để vào org với đúng vai trò đã gắn trong mã.
 *
 * Mã dùng MỘT LẦN: đánh dấu `acceptedAt` và tạo Membership trong cùng một transaction, và câu update mã
 * có điều kiện `acceptedAt: null` — hai người cùng nhập một mã thì chỉ một người vào được, người kia
 * nhận 410 chứ không phải cả hai cùng vào.
 */
export const acceptInvitation = async (
  code: string,
  userId: string,
  email: string,
  platformRole?: string
): Promise<AcceptResult> => {
  const codeHash = hashCode(code)
  const invitation = await Invitation.findOne({ codeHash }).lean()
  if (!invitation || invitationState(invitation) !== "pending") throw invalidCode()

  const orgId = String(invitation.organizationId)
  const org = await Organization.findById(orgId).select("name").lean()
  if (!org) throw invalidCode()

  if (await Membership.exists({ organizationId: orgId, userId })) {
    throw new ApiError(409, "Bạn đã là thành viên của tổ chức này", "ALREADY_MEMBER")
  }
  await assertMemberQuota(orgId)

  const join = async (session?: mongoose.ClientSession) => {
    const claimed = await Invitation.findOneAndUpdate(
      { _id: invitation._id, acceptedAt: null, revokedAt: null },
      { acceptedAt: new Date(), acceptedByUserId: userId },
      { ...sessionOptions(session), new: true }
    )
    if (!claimed) throw invalidCode()
    await Membership.create(
      [{ organizationId: orgId, userId, role: invitation.role, joinedAt: new Date() }],
      sessionOptions(session)
    )
  }

  const result = await runInTransaction(join)
  if (result === TRANSACTION_UNAVAILABLE) await join()
  await markOnboarded(userId)

  // Flow SD-3.3-5: Lead cần biết có người mới vào.
  const [leads, joiner] = await Promise.all([
    Membership.find({ organizationId: orgId, role: "lead" }).select("userId").lean(),
    User.findById(userId).select("name email").lean()
  ])
  const who = joiner?.name || joiner?.email || "Một người"
  for (const lead of leads) {
    void notify(String(lead.userId), {
      type: "org_member_joined",
      title: "Thành viên mới tham gia tổ chức",
      body: `${who} đã tham gia ${org.name} với vai trò ${ROLE_LABELS[invitation.role]}.`,
      organizationId: orgId,
      meta: { organizationId: orgId, userId, role: invitation.role }
    })
  }

  return {
    organization: { id: orgId, name: org.name, role: invitation.role },
    accessToken: signAccessToken({
      userId,
      email,
      ...(platformRole ? { role: platformRole } : {}),
      orgId
    })
  }
}
