import crypto from "node:crypto"
import mongoose from "mongoose"
import { Invitation, INVITABLE_ROLES, type InvitableRole } from "./invitation.model.js"
import { Membership, ORG_ROLE_LABELS, type OrgRole } from "./membership.model.js"
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
  analyst: ORG_ROLE_LABELS.analyst,
  viewer: ORG_ROLE_LABELS.viewer
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

export type InvitationState = "pending" | "awaiting_approval" | "accepted" | "revoked" | "rejected" | "expired"

/** Trạng thái là giá trị SUY DIỄN từ các mốc thời gian — model cố tình không có field status. */
export const invitationState = (
  invitation: {
    acceptedAt?: Date | null
    revokedAt?: Date | null
    rejectedAt?: Date | null
    requestedByUserId?: unknown
    approvedAt?: Date | null
    expiresAt: Date
  },
  now: Date = new Date()
): InvitationState => {
  if (invitation.revokedAt) return "revoked"
  if (invitation.rejectedAt) return "rejected"
  if (invitation.acceptedAt) return "accepted"
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired"
  if (invitation.requestedByUserId && !invitation.approvedAt) return "awaiting_approval"
  return "pending"
}

export interface InvitationItem {
  id: string
  email: string | null
  role: InvitableRole
  state: InvitationState
  /** Analyst đã gửi yêu cầu mời (FLF-303); null = Lead mời thẳng. */
  requestedBy: { id: string; name: string } | null
  expiresAt: Date
  createdAt: Date
}

interface InvitationRecord {
  _id: unknown
  email: string | null
  role: InvitableRole
  requestedByUserId?: unknown
  approvedAt?: Date | null
  rejectedAt?: Date | null
  acceptedAt?: Date | null
  revokedAt?: Date | null
  expiresAt: Date
  createdAt: Date
}

const toItem = (invitation: InvitationRecord, requesterName = ""): InvitationItem => ({
  id: String(invitation._id),
  email: invitation.email,
  role: invitation.role,
  state: invitationState(invitation),
  requestedBy: invitation.requestedByUserId
    ? { id: String(invitation.requestedByUserId), name: requesterName }
    : null,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt
})

const displayName = (user: { name?: string | null; email?: string | null } | null | undefined, fallback: string) =>
  user?.name || user?.email || fallback

/** Gắn tên người yêu cầu cho cả danh sách bằng một lượt đọc User. */
const toItems = async (invitations: InvitationRecord[]): Promise<InvitationItem[]> => {
  const requesterIds = [
    ...new Set(invitations.flatMap((i) => (i.requestedByUserId ? [String(i.requestedByUserId)] : [])))
  ]
  const users = requesterIds.length ? await User.find({ _id: { $in: requesterIds } }).select("name email").lean() : []
  const names = new Map(users.map((u) => [String(u._id), displayName(u, "")]))
  return invitations.map((i) => toItem(i, names.get(String(i.requestedByUserId))))
}

const invalidCode = () =>
  new ApiError(410, "Mã mời không dùng được: đã hết hạn, đã dùng hoặc đã bị thu hồi", "INVITE_INVALID")

const notFound = () => new ApiError(404, "Không tìm thấy lời mời", "INVITE_NOT_FOUND")

const notAwaiting = () =>
  new ApiError(
    409,
    "Lời mời không còn chờ duyệt: đã được xử lý, đã huỷ hoặc đã hết hạn",
    "INVITE_NOT_AWAITING_APPROVAL"
  )

export interface CreatedInvitation extends InvitationItem {
  /** Mã thô — CHỈ trả đúng lượt sinh mã này. DB chỉ giữ hash, nên mất là phải thu hồi và mời lại. */
  code: string
}

/** Hạn mã tính từ lúc mã được sinh — lúc Lead tạo hoặc lúc Lead duyệt, không phải lúc Analyst gửi yêu cầu. */
const freshExpiry = () => new Date(Date.now() + env.INVITE_TTL_DAYS * 86_400_000)

/**
 * Email Service gửi mã cho người được mời. Là side effect qua hàng đợi email (tự retry): hỏng SMTP — kể cả không
 * đưa được vào Redis — không được làm hỏng việc sinh mã (Lead vẫn đọc được mã ở response).
 */
const sendCode = async (orgId: string, inviterUserId: string, email: string, role: InvitableRole, code: string) => {
  const [org, inviter] = await Promise.all([
    Organization.findById(orgId).select("name").lean(),
    User.findById(inviterUserId).select("name email").lean()
  ])
  await sendOrgInvitationEmail(email, {
    code,
    organizationName: org?.name ?? "FlintFlow",
    roleLabel: ROLE_LABELS[role],
    inviterName: displayName(inviter, "Một thành viên"),
    expiresInDays: env.INVITE_TTL_DAYS
  }).catch((err: unknown) => console.error(`[invitation] Không đưa được email mời ${email} vào hàng đợi:`, err))
}

const MEMBERS_LINK = "/home/members"

/**
 * FLF-303: Analyst chỉ tạo YÊU CẦU mời chờ Lead duyệt — không sinh mã, không gửi email, không kiểm trần thành viên
 * (kiểm lúc duyệt, vì số thành viên có thể đổi giữa hai thời điểm). Mọi Lead của org được báo.
 */
const requestInvitation = async (
  orgId: string,
  requesterUserId: string,
  role: InvitableRole,
  email: string
): Promise<InvitationItem> => {
  const invitation = await Invitation.create({
    organizationId: orgId,
    email,
    role,
    // Không phải mã: hash của chuỗi ngẫu nhiên bị bỏ ngay — xem chú thích ở invitation.model.ts
    codeHash: hashCode(crypto.randomBytes(32).toString("hex")),
    expiresAt: freshExpiry(),
    invitedByUserId: requesterUserId,
    requestedByUserId: requesterUserId
  })

  const [org, requester, leads] = await Promise.all([
    Organization.findById(orgId).select("name").lean(),
    User.findById(requesterUserId).select("name email").lean(),
    Membership.find({ organizationId: orgId, role: "lead" }).select("userId").lean()
  ])
  const who = displayName(requester, "Một Analyst")
  for (const lead of leads) {
    void notify(String(lead.userId), {
      type: "org_invitation_requested",
      title: "Có yêu cầu mời thành viên chờ duyệt",
      body: `${who} muốn mời ${email} vào ${org?.name ?? "tổ chức"} với vai trò ${ROLE_LABELS[role]}.`,
      link: MEMBERS_LINK,
      organizationId: orgId,
      // Đủ tham số để FE dựng lại câu theo ngôn ngữ người xem (lib/notification-text.ts)
      meta: {
        organizationId: orgId,
        organizationName: org?.name ?? null,
        invitationId: String(invitation._id),
        requestedBy: requesterUserId,
        requesterName: who,
        email,
        role
      }
    })
  }

  return toItem(invitation, who)
}

/**
 * UC-08 / BPMN Flow 9.1–9.2: Lead sinh mã mời có hạn kèm vai trò, Email Service gửi cho người được mời.
 * Analyst gọi thì thành yêu cầu chờ duyệt (`requestInvitation`, FLF-303) — response không có `code`.
 *
 * Vai trò chỉ nhận Analyst / Viewer: muốn thêm Lead thì mời trước rồi nâng bằng UC-73, để việc tạo Lead
 * luôn là hành động có chủ đích của một Lead đang có chứ không phải hệ quả của mã phát đi từ lâu.
 */
export const createInvitation = async (
  orgId: string,
  inviterUserId: string,
  inviterRole: OrgRole,
  role: InvitableRole,
  email: string
): Promise<CreatedInvitation | InvitationItem> => {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new ApiError(400, "Chỉ mời được với vai trò Analyst hoặc Viewer", "VALIDATION_ERROR")
  }
  if (inviterRole !== "lead") return requestInvitation(orgId, inviterUserId, role, email)

  await assertMemberQuota(orgId)

  const code = generateCode()
  const invitation = await Invitation.create({
    organizationId: orgId,
    email,
    role,
    codeHash: hashCode(code),
    expiresAt: freshExpiry(),
    invitedByUserId: inviterUserId
  })
  await sendCode(orgId, inviterUserId, email, role, code)

  return { ...toItem(invitation), code }
}

const findInOrg = async (orgId: string, invitationId: string) => {
  if (!mongoose.isValidObjectId(invitationId)) throw notFound()
  const invitation = await Invitation.findOne({ _id: invitationId, organizationId: orgId })
  if (!invitation) throw notFound()
  return invitation
}

/** Điều kiện ghi chung cho duyệt / từ chối: hai Lead bấm cùng lúc thì chỉ một người thắng, người kia nhận 409. */
const stillAwaiting = (invitationId: mongoose.Types.ObjectId) => ({
  _id: invitationId,
  requestedByUserId: { $ne: null },
  approvedAt: null,
  rejectedAt: null,
  revokedAt: null,
  expiresAt: { $gt: new Date() }
})

/** Báo người gửi yêu cầu kết quả Lead duyệt / từ chối. */
const notifyRequester = async (
  orgId: string,
  invitation: { _id: unknown; email: string | null; requestedByUserId: unknown },
  approved: boolean
) => {
  const org = await Organization.findById(orgId).select("name").lean()
  const orgName = org?.name ?? "tổ chức"
  void notify(String(invitation.requestedByUserId), {
    type: approved ? "org_invitation_approved" : "org_invitation_rejected",
    title: approved ? "Yêu cầu mời thành viên đã được duyệt" : "Yêu cầu mời thành viên bị từ chối",
    body: approved
      ? `Lead đã duyệt lời mời ${invitation.email} vào ${orgName}; mã mời đã được gửi qua email.`
      : `Lead đã từ chối lời mời ${invitation.email} vào ${orgName}.`,
    link: MEMBERS_LINK,
    organizationId: orgId,
    meta: {
      organizationId: orgId,
      organizationName: org?.name ?? null,
      invitationId: String(invitation._id),
      email: invitation.email
    }
  })
}

/**
 * FLF-303: Lead duyệt yêu cầu mời của Analyst. Lúc này mới kiểm trần thành viên, sinh mã và gửi email. Mã thô trả
 * cho Lead đúng lượt này, giống khi Lead tự mời. Hạn mã tính lại từ lúc duyệt.
 */
export const approveInvitation = async (
  orgId: string,
  invitationId: string,
  leadUserId: string
): Promise<CreatedInvitation> => {
  const invitation = await findInOrg(orgId, invitationId)
  if (invitationState(invitation) !== "awaiting_approval") throw notAwaiting()
  await assertMemberQuota(orgId)

  const code = generateCode()
  const approved = await Invitation.findOneAndUpdate(
    stillAwaiting(invitation._id),
    { codeHash: hashCode(code), approvedAt: new Date(), approvedByUserId: leadUserId, expiresAt: freshExpiry() },
    { returnDocument: "after" }
  ).lean()
  // Yêu cầu từ Analyst luôn có email (bắt buộc từ 2026-10-04) — thiếu là dữ liệu hỏng, không duyệt được
  if (!approved?.email) throw notAwaiting()

  await sendCode(orgId, String(approved.invitedByUserId), approved.email, approved.role, code)
  await notifyRequester(orgId, approved, true)

  const [item] = await toItems([approved])
  return { ...item, code }
}

/** FLF-303: Lead từ chối yêu cầu mời. Chưa có mã nào từng tồn tại nên không có gì phải thu hồi thêm. */
export const rejectInvitation = async (
  orgId: string,
  invitationId: string,
  leadUserId: string
): Promise<InvitationItem> => {
  const invitation = await findInOrg(orgId, invitationId)
  if (invitationState(invitation) !== "awaiting_approval") throw notAwaiting()

  const rejected = await Invitation.findOneAndUpdate(
    stillAwaiting(invitation._id),
    { rejectedAt: new Date(), rejectedByUserId: leadUserId },
    { returnDocument: "after" }
  ).lean()
  if (!rejected) throw notAwaiting()

  await notifyRequester(orgId, rejected, false)
  const [item] = await toItems([rejected])
  return item
}

/**
 * UC-08 (phần xem): lời mời của org, mới nhất trước. Không bao giờ trả mã thô.
 * Lead thấy tất cả; Analyst chỉ thấy lời mời do chính mình tạo (FLF-303).
 */
export const listInvitations = async (orgId: string, userId: string, role: OrgRole): Promise<InvitationItem[]> => {
  const filter = role === "lead" ? { organizationId: orgId } : { organizationId: orgId, invitedByUserId: userId }
  const invitations = await Invitation.find(filter).sort({ createdAt: -1 }).lean()
  return toItems(invitations)
}

/**
 * UC-08: Lead thu hồi một mã CHƯA dùng. Mã đã dùng thì không thu hồi được — người kia đã vào org rồi.
 * FLF-303: Analyst chỉ huỷ được yêu cầu của chính mình khi còn chờ duyệt; đã duyệt thì chỉ Lead thu hồi.
 */
export const revokeInvitation = async (
  orgId: string,
  invitationId: string,
  userId: string,
  role: OrgRole
): Promise<InvitationItem> => {
  const invitation = await findInOrg(orgId, invitationId)
  const state = invitationState(invitation)

  if (role !== "lead") {
    // Lời mời của người khác không có trong danh sách của Analyst ⇒ coi như không tồn tại
    if (String(invitation.invitedByUserId) !== userId) throw notFound()
    if (state !== "awaiting_approval") {
      throw new ApiError(403, "Lời mời đã được Lead xử lý - chỉ Lead thu hồi được", "ORG_ROLE_FORBIDDEN")
    }
  }
  if (state === "accepted") {
    throw new ApiError(409, "Mã đã được dùng - hãy xoá thành viên nếu muốn thu hồi quyền", "INVITE_ALREADY_USED")
  }
  if (state !== "revoked" && state !== "rejected") {
    invitation.revokedAt = new Date()
    await invitation.save()
  }
  const [item] = await toItems([invitation.toObject()])
  return item
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
  const who = displayName(joiner, "Một người")
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
