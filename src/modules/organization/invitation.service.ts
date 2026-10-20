import crypto from "node:crypto"
import mongoose from "mongoose"
import { Invitation, INVITABLE_ROLES, type InvitableRole } from "./invitation.model.js"
import { Membership, ORG_ROLE_LABELS } from "./membership.model.js"
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

export type InvitationState = "pending" | "accepted" | "declined" | "revoked" | "expired"

/** Trạng thái là giá trị SUY DIỄN từ các mốc thời gian — model cố tình không có field status. */
export const invitationState = (
  invitation: { acceptedAt?: Date | null; declinedAt?: Date | null; revokedAt?: Date | null; expiresAt: Date },
  now: Date = new Date()
): InvitationState => {
  if (invitation.revokedAt) return "revoked"
  if (invitation.acceptedAt) return "accepted"
  if (invitation.declinedAt) return "declined"
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
  declinedAt?: Date | null
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

const invitationNotFound = () => new ApiError(404, "Không tìm thấy lời mời", "INVITE_NOT_FOUND")

/** Lọc Mongo cho lời mời còn dùng được — cùng nghĩa với `invitationState(...) === "pending"`. */
const pendingFilter = (now: Date = new Date()) => ({
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  expiresAt: { $gt: now }
})

/**
 * Lời mời gửi tới email nào thì chỉ tài khoản đăng nhập bằng đúng email đó dùng được (như lời mời collaborator của
 * GitHub): người khác cầm được mã cũng không vào được. Có `inviteeUserId` thì đối chiếu thêm — hiện tài khoản không
 * đổi được email nên hai điều kiện trùng nhau, giữ cả hai để sau này có đổi email cũng không lọt. Mã rất cũ không
 * có cả email (thời "mã dùng chung") giữ hành vi cũ.
 */
const isInvitee = (
  invitation: { inviteeUserId?: unknown; email: string | null },
  userId: string,
  email: string
): boolean => {
  if (invitation.email && invitation.email !== email.trim().toLowerCase()) return false
  if (invitation.inviteeUserId && String(invitation.inviteeUserId) !== userId) return false
  return true
}

const emailMismatch = () =>
  new ApiError(403, "Mã mời này dành cho một email khác — hãy đăng nhập bằng đúng tài khoản được mời", "INVITE_EMAIL_MISMATCH")

/**
 * Mã gõ tay (xem trước / nhận): mã hỏng ⇒ 410; mã còn dùng được nhưng của email khác ⇒ 403 nói rõ, vì trường hợp
 * hay gặp là người được mời đang đăng nhập nhầm tài khoản — báo "mã hết hạn" sẽ làm họ tưởng phải xin mã mới.
 * Mã 10 ký tự ≈ 49 bit nên báo rõ không giúp ai dò mã.
 */
const findUsableCode = async (code: string, userId: string, email: string) => {
  const invitation = await Invitation.findOne({ codeHash: hashCode(code) }).lean()
  if (!invitation || invitationState(invitation) !== "pending") throw invalidCode()
  if (!isInvitee(invitation, userId, email)) throw emailMismatch()
  return invitation
}

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
  email: string
): Promise<CreatedInvitation> => {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new ApiError(400, "Chỉ mời được với vai trò Analyst hoặc Viewer", "VALIDATION_ERROR")
  }
  await assertMemberQuota(orgId)

  // Người được mời phải đăng ký trước (như GitHub): mời một địa chỉ chưa có tài khoản (thường là gõ nhầm) thì mã gửi
  // đi vô ích. Kiểm trước khi sinh mã để không tạo mã rác, không gửi mail.
  const invitee = await User.findOne({ email }).select("_id name isActive").lean()
  if (!invitee) {
    throw new ApiError(404, "Email này chưa có tài khoản FlintFlow — hãy nhờ người được mời đăng ký trước", "INVITEE_NOT_FOUND")
  }
  // Tài khoản bị khoá không đăng nhập được nên cũng không nhập mã được — báo rõ để Lead khỏi chờ một lời mời vô ích.
  if (invitee.isActive === false) {
    throw new ApiError(409, "Tài khoản bạn mời đang bị khoá — không thể mời vào tổ chức", "INVITEE_SUSPENDED")
  }
  if (await Membership.exists({ organizationId: orgId, userId: invitee._id })) {
    throw new ApiError(409, "Người này đã là thành viên của tổ chức", "INVITEE_ALREADY_MEMBER")
  }
  if (await Invitation.exists({ organizationId: orgId, email, ...pendingFilter() })) {
    throw new ApiError(409, "Email này đang có lời mời chờ chấp nhận — thu hồi lời mời cũ nếu muốn gửi lại", "INVITE_ALREADY_PENDING")
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + env.INVITE_TTL_DAYS * 86_400_000)
  const invitation = await Invitation.create({
    organizationId: orgId,
    email,
    inviteeUserId: invitee._id,
    role,
    codeHash: hashCode(code),
    expiresAt,
    invitedByUserId: inviterUserId
  })

  const [org, inviter] = await Promise.all([
    Organization.findById(orgId).select("name").lean(),
    User.findById(inviterUserId).select("name email").lean()
  ])
  // Gửi mail là side effect qua hàng đợi email (tự retry): hỏng SMTP — kể cả không đưa được vào Redis — không được
  // làm hỏng việc tạo mã (Lead vẫn đọc được mã ở response).
  const organizationName = org?.name ?? "FlintFlow"
  const inviterName = inviter?.name || inviter?.email || "Một thành viên"
  await sendOrgInvitationEmail(email, {
    ...(invitee.name ? { name: invitee.name } : {}),
    code,
    organizationName,
    roleLabel: ROLE_LABELS[role],
    inviterName,
    expiresInDays: env.INVITE_TTL_DAYS
  }).catch((err: unknown) => console.error(`[invitation] Không đưa được email mời ${email} vào hàng đợi:`, err))

  // Người được mời thấy lời mời ngay trong app, chấp nhận / từ chối không cần gõ mã. Thông báo cấp nền tảng
  // (không gắn org): họ chưa thuộc org mời nên thông báo gắn org đó sẽ không hiện ở org nào của họ.
  void notify(String(invitee._id), {
    type: "org_invitation",
    title: "Lời mời tham gia tổ chức",
    body: `${inviterName} mời bạn tham gia ${organizationName} với vai trò ${ROLE_LABELS[role]}.`,
    link: "/home/organizations",
    meta: { invitationId: String(invitation._id), organizationId: orgId, role }
  })

  return { ...toItem(invitation), code }
}

/** UC-08 (phần xem): mã đang treo của org, mới nhất trước. Không bao giờ trả mã thô. */
export const listInvitations = async (orgId: string): Promise<InvitationItem[]> => {
  const invitations = await Invitation.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean()
  return invitations.map(toItem)
}

/** UC-08: Lead thu hồi một mã CHƯA dùng. Mã đã dùng thì không thu hồi được — người kia đã vào org rồi. */
export const revokeInvitation = async (orgId: string, invitationId: string): Promise<InvitationItem> => {
  if (!mongoose.isValidObjectId(invitationId)) throw invitationNotFound()
  const invitation = await Invitation.findOne({ _id: invitationId, organizationId: orgId })
  if (!invitation) throw invitationNotFound()

  const state = invitationState(invitation)
  if (state === "accepted") {
    throw new ApiError(409, "Mã đã được dùng — hãy xoá thành viên nếu muốn thu hồi quyền", "INVITE_ALREADY_USED")
  }
  // Đã từ chối thì giữ nguyên "declined" cho Lead đọc đúng chuyện đã xảy ra; mã cũng đã hết dùng được.
  if (state !== "revoked" && state !== "declined") {
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

/** Xem trước trước khi bấm tham gia (Flow 8.3). Chỉ người dùng đúng email được mời mới xem được. */
export const previewInvitation = async (code: string, userId: string, email: string): Promise<InvitationPreview> => {
  const invitation = await findUsableCode(code, userId, email)

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
 * Phần chung của nhận lời mời, bằng mã (UC-09) hay bấm "Chấp nhận" trong app. Người gọi đã kiểm lời mời còn hạn
 * và đúng người được mời.
 *
 * Mã dùng MỘT LẦN: đánh dấu `acceptedAt` và tạo Membership trong cùng một transaction, và câu update mã
 * có điều kiện `acceptedAt: null` — hai lượt nhận cùng lúc thì chỉ một lượt vào được, lượt kia
 * nhận lỗi chứ không phải cả hai cùng vào.
 */
const joinWithInvitation = async (
  invitation: { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; role: InvitableRole },
  userId: string,
  email: string,
  platformRole: string | undefined,
  unusable: () => ApiError
): Promise<AcceptResult> => {
  const orgId = String(invitation.organizationId)
  const org = await Organization.findById(orgId).select("name").lean()
  if (!org) throw unusable()

  if (await Membership.exists({ organizationId: orgId, userId })) {
    throw new ApiError(409, "Bạn đã là thành viên của tổ chức này", "ALREADY_MEMBER")
  }
  await assertMemberQuota(orgId)

  const join = async (session?: mongoose.ClientSession) => {
    const claimed = await Invitation.findOneAndUpdate(
      { _id: invitation._id, acceptedAt: null, declinedAt: null, revokedAt: null },
      { acceptedAt: new Date(), acceptedByUserId: userId },
      { ...sessionOptions(session), new: true }
    )
    if (!claimed) throw unusable()
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

/** UC-09 / BPMN Flow 8.3–8.5: nhập mã mời để vào org với đúng vai trò đã gắn trong mã. Chỉ người được mời dùng được. */
export const acceptInvitation = async (
  code: string,
  userId: string,
  email: string,
  platformRole?: string
): Promise<AcceptResult> => {
  const invitation = await findUsableCode(code, userId, email)
  return joinWithInvitation(invitation, userId, email, platformRole, invalidCode)
}

export interface MyInvitationItem {
  id: string
  organizationId: string
  organizationName: string
  role: InvitableRole
  roleLabel: string
  inviterName: string
  expiresAt: Date
  createdAt: Date
}

/** Lời mời đang chờ của chính người đăng nhập, mới nhất trước — mục "Lời mời đang chờ" (như GitHub). */
export const listMyInvitations = async (userId: string, email: string): Promise<MyInvitationItem[]> => {
  const invitations = await Invitation.find({
    $or: [{ inviteeUserId: userId }, { inviteeUserId: null, email: email.trim().toLowerCase() }],
    ...pendingFilter()
  })
    .sort({ createdAt: -1 })
    .lean()
  if (invitations.length === 0) return []

  const [orgs, inviters] = await Promise.all([
    Organization.find({ _id: { $in: invitations.map((inv) => inv.organizationId) } }).select("name").lean(),
    User.find({ _id: { $in: invitations.map((inv) => inv.invitedByUserId) } }).select("name email").lean()
  ])
  const orgName = new Map(orgs.map((org) => [String(org._id), org.name]))
  const inviterName = new Map(inviters.map((u) => [String(u._id), u.name || u.email]))

  // Org đã xoá thì lời mời không còn ý nghĩa — bỏ qua thay vì hiện một dòng không tên.
  return invitations
    .filter((inv) => orgName.has(String(inv.organizationId)))
    .map((inv) => ({
      id: String(inv._id),
      organizationId: String(inv.organizationId),
      organizationName: orgName.get(String(inv.organizationId)) as string,
      role: inv.role,
      roleLabel: ROLE_LABELS[inv.role],
      inviterName: inviterName.get(String(inv.invitedByUserId)) ?? "Một thành viên",
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt
    }))
}

/** Lời mời của người khác trả 404 như không có — không lộ id lời mời nào đang tồn tại. */
const findMyInvitation = async (invitationId: string, userId: string, email: string) => {
  if (!mongoose.isValidObjectId(invitationId)) throw invitationNotFound()
  const invitation = await Invitation.findById(invitationId).lean()
  if (!invitation || !isInvitee(invitation, userId, email)) throw invitationNotFound()
  if (invitationState(invitation) !== "pending") throw invalidCode()
  return invitation
}

/** Bấm "Chấp nhận" trong mục lời mời đang chờ — cùng kết quả với nhập mã, không phải gõ mã. */
export const acceptMyInvitation = async (
  invitationId: string,
  userId: string,
  email: string,
  platformRole?: string
): Promise<AcceptResult> => {
  const invitation = await findMyInvitation(invitationId, userId, email)
  return joinWithInvitation(invitation, userId, email, platformRole, invalidCode)
}

/** Người được mời từ chối. Lead mời được lại sau đó vì lời mời này không còn "đang chờ". */
export const declineInvitation = async (
  invitationId: string,
  userId: string,
  email: string
): Promise<InvitationItem> => {
  const invitation = await findMyInvitation(invitationId, userId, email)
  const declined = await Invitation.findOneAndUpdate(
    { _id: invitation._id, ...pendingFilter() },
    { declinedAt: new Date() },
    { new: true }
  ).lean()
  if (!declined) throw invalidCode()

  const orgId = String(invitation.organizationId)
  const [org, decliner] = await Promise.all([
    Organization.findById(orgId).select("name").lean(),
    User.findById(userId).select("name email").lean()
  ])
  void notify(String(invitation.invitedByUserId), {
    type: "org_invitation_declined",
    title: "Lời mời bị từ chối",
    body: `${decliner?.name || decliner?.email || "Người được mời"} đã từ chối lời mời tham gia ${org?.name ?? "tổ chức"}.`,
    organizationId: orgId,
    meta: { organizationId: orgId, invitationId: String(invitation._id), userId }
  })

  return toItem(declined)
}
