import mongoose, { PipelineStage } from "mongoose"
import { User, UserRole } from "../user/user.model.js"
import { Project } from "../project/project.model.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { Membership } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { Organization } from "../organization/organization.model.js"
import { Subscription } from "../credits/subscription.model.js"
import { getPlan, PlanId } from "../billing/plan.config.js"
import { CreditTransaction } from "../credits/credit-transaction.model.js"
import { Session } from "../../shared/auth/session.model.js"
import { revokeAllUserSessions } from "../../shared/auth/session.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Baseline } from "../spine/baseline.model.js"
import { AiActionLog } from "./ai-action-log.model.js"
import * as feedbackService from "../feedback/feedback.service.js"
import {
  AiCostGroupBy,
  OrgsQuery,
  parseDateInput,
  REPORT_TIMEZONE,
  SetUserStatusInput,
  UsersQuery
} from "./admin.validation.js"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Bảng giá tạm (USD / 1K token) để ước tính chi phí provider.
 * TODO(T04): chuyển sang `plan.config.providerUsdPer1k` khi T04 bổ sung.
 */
export const PROVIDER_USD_PER_1K: Record<string, { input: number; output: number }> = {
  openai: { input: 0.00015, output: 0.0006 },
  anthropic: { input: 0.003, output: 0.015 },
  gemini: { input: 0.0003, output: 0.0025 },
  mock: { input: 0, output: 0 }
}

export const estimateUsd = (provider: string, promptTokens: number, completionTokens: number): number => {
  const price = PROVIDER_USD_PER_1K[provider]
  if (!price) return 0
  return (promptTokens / 1000) * price.input + (completionTokens / 1000) * price.output
}

const roundUsd = (value: number) => Math.round(value * 1_000_000) / 1_000_000

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ─── 10.1 User list ──────────────────────────────────────────────

export interface AdminUserRow {
  _id: string
  email: string
  name: string | null
  role: UserRole
  isActive: boolean
  suspendedAt: Date | null
  suspendReason: string | null
  emailVerified: boolean
  authProvider: string
  createdAt: Date
  /**
   * task-26: KHÔNG còn `walletBalance`. Ví là của tổ chức, không của người — một người ở nhiều org thì
   * "số dư của user" không có nghĩa. Số dư từng org xem ở `getUserDetail`.
   */
  organizationsCount: number
  projectsCount: number
  lastLoginAt: Date | null
}

type UserLean = {
  _id: mongoose.Types.ObjectId
  email: string
  name?: string
  role: UserRole
  isActive: boolean
  suspendedAt?: Date | null
  suspendReason?: string | null
  emailVerified: boolean
  authProvider: string
  createdAt: Date
}

/** Gắn wallet.balance, projectsCount, lastLoginAt (Session mới nhất) cho danh sách user. */
const enrichUsers = async (users: UserLean[]): Promise<AdminUserRow[]> => {
  if (users.length === 0) return []
  const userIds = users.map((u) => u._id)
  const byUser = { $match: { userId: { $in: userIds } } }

  const [memberships, projectCounts, lastLogins] = await Promise.all([
    Membership.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      byUser,
      { $group: { _id: "$userId", count: { $sum: 1 } } }
    ]),
    Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      byUser,
      { $group: { _id: "$userId", count: { $sum: 1 } } }
    ]),
    Session.aggregate<{ _id: mongoose.Types.ObjectId; at: Date }>([
      byUser,
      { $group: { _id: "$userId", at: { $max: "$createdAt" } } }
    ])
  ])
  const orgCounts = new Map(memberships.map((r) => [String(r._id), r.count]))
  const projectsCount = new Map(projectCounts.map((r) => [String(r._id), r.count]))
  const lastLoginAt = new Map(lastLogins.map((r) => [String(r._id), r.at]))

  return users.map((u) => {
    const id = String(u._id)
    return {
      _id: id,
      email: u.email,
      name: u.name ?? null,
      role: u.role,
      isActive: u.isActive,
      suspendedAt: u.suspendedAt ?? null,
      suspendReason: u.suspendReason ?? null,
      emailVerified: u.emailVerified,
      authProvider: u.authProvider,
      createdAt: u.createdAt,
      organizationsCount: orgCounts.get(id) ?? 0,
      projectsCount: projectsCount.get(id) ?? 0,
      lastLoginAt: lastLoginAt.get(id) ?? null
    }
  })
}

export const listUsers = async (query: UsersQuery) => {
  const { page, limit, role, isActive, q } = query
  const filter: Record<string, unknown> = {}
  if (role) filter.role = role
  if (isActive !== undefined) filter.isActive = isActive
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i")
    filter.$or = [{ email: pattern }, { name: pattern }]
  }

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
  ])

  return {
    items: await enrichUsers(users),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  }
}

export const getUserDetail = async (userId: string) => {
  const user = await User.findById(userId).lean()
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng", "USER_NOT_FOUND")
  }

  const [[row], memberships, recentTransactions] = await Promise.all([
    enrichUsers([user]),
    Membership.find({ userId: user._id }).lean(),
    // Giao dịch DO CHÍNH NGƯỜI NÀY thực hiện — ví là của org nhưng ledger vẫn ghi ai tiêu (UC-79).
    CreditTransaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean()
  ])

  const orgIds = memberships.map((m) => m.organizationId)
  const [orgs, wallets] = await Promise.all([
    Organization.find({ _id: { $in: orgIds } }).select("_id name").lean(),
    CreditWallet.find({ organizationId: { $in: orgIds } }).lean()
  ])
  const orgById = new Map(orgs.map((o) => [String(o._id), o]))
  const walletByOrg = new Map(wallets.map((w) => [String(w.organizationId), w]))

  return {
    ...row,
    // UC-65: admin thấy người này ở org nào, vai trò gì, và ví của org đó còn bao nhiêu.
    organizations: memberships.map((m) => {
      const id = String(m.organizationId)
      const wallet = walletByOrg.get(id)
      return {
        id,
        name: orgById.get(id)?.name ?? "(đã xoá)",
        role: m.role,
        joinedAt: m.joinedAt,
        wallet: wallet ? { balance: wallet.balance, reserved: wallet.reserved } : null
      }
    }),
    recentTransactions
  }
}

export interface UserStatusResult {
  _id: string
  isActive: boolean
  suspendedAt: Date | null
  suspendReason: string | null
  reactivatedAt: Date | null
  reactivateReason: string | null
}

/**
 * UC-60 khoá / UC-61 mở khoá tài khoản. Khoá thì thu hồi luôn mọi phiên: refresh token chết ngay, access
 * token còn hạn bị `requireActiveAccount` chặn từ request kế tiếp. Gọi với trạng thái đang có ⇒ 409, không
 * đổi gì (Report 3: "already suspended / already active"). Mở khoá ghi lý do + thời điểm lên tài khoản.
 */
export const setUserStatus = async (
  adminId: string,
  userId: string,
  input: SetUserStatusInput
): Promise<UserStatusResult> => {
  // Admin tự khoá mình thì mất quyền vào khu quản trị, và nếu là admin duy nhất thì không ai mở lại được.
  if (!input.isActive && adminId === userId) {
    throw new ApiError(400, "Không thể tự khoá tài khoản của chính mình", "CANNOT_SUSPEND_SELF")
  }

  const user = await User.findById(userId)
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng", "USER_NOT_FOUND")
  }

  if (user.isActive === input.isActive) {
    throw input.isActive
      ? new ApiError(409, "Tài khoản này đang hoạt động", "USER_ALREADY_ACTIVE")
      : new ApiError(409, "Tài khoản này đã bị khoá", "USER_ALREADY_SUSPENDED")
  }

  user.isActive = input.isActive
  user.suspendedAt = input.isActive ? null : new Date()
  user.suspendReason = input.isActive ? null : input.reason
  if (input.isActive) {
    user.reactivatedAt = new Date()
    user.reactivateReason = input.reason
  }
  await user.save()
  if (!input.isActive) await revokeAllUserSessions(userId)

  return {
    _id: String(user._id),
    isActive: user.isActive,
    suspendedAt: user.suspendedAt ?? null,
    suspendReason: user.suspendReason ?? null,
    reactivatedAt: user.reactivatedAt ?? null,
    reactivateReason: user.reactivateReason ?? null
  }
}

// ─── 10.2 Metrics ────────────────────────────────────────────────

export const getMetrics = async (now: Date = new Date()) => {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS)
  // en-CA định dạng YYYY-MM-DD → đầu ngày hôm nay theo REPORT_TIMEZONE
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE }).format(now)
  const startOfToday = parseDateInput(today, "start")

  const [usersTotal, usersNew7d, projectsTotal, projectsActive7d, baselinesTotal, aiCallsToday, aiStatus7d] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
    Project.countDocuments({}),
    Project.countDocuments({ updatedAt: { $gte: sevenDaysAgo } }),
    // UC-63: mọi baseline đã ghi — v0 khi import, 1.0 và mọi bản release sau đó
    Baseline.countDocuments({}),
    AiActionLog.countDocuments({ createdAt: { $gte: startOfToday } }),
    AiActionLog.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ])
  ])

  const calls7d = aiStatus7d.reduce((sum, r) => sum + r.count, 0)
  const failed7d = aiStatus7d.find((r) => r._id === "failed")?.count ?? 0

  return {
    usersTotal,
    usersNew7d,
    projectsTotal,
    projectsActive7d,
    baselinesTotal,
    aiCallsToday,
    aiCalls7d: calls7d,
    aiFailRate7d: calls7d === 0 ? 0 : failed7d / calls7d
  }
}

// ─── 10.3 AI cost ────────────────────────────────────────────────

export interface AiCostRow {
  key: string
  label: string
  calls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
  credits: number
  estimatedUsd: number
}

export interface TokenGroup {
  key: string
  provider: string
  calls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
}

export interface CreditGroup {
  key: string
  credits: number
}

/** Credit không gắn provider (CreditTransaction không lưu provider). */
export const UNATTRIBUTED_KEY = "unattributed"

const groupKeyExpr = (groupBy: AiCostGroupBy, source: "log" | "credit"): unknown => {
  switch (groupBy) {
    case "day":
      return { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: REPORT_TIMEZONE } }
    case "actionType":
      return "$actionType"
    case "user":
      return { $toString: "$userId" }
    case "provider":
      return source === "log" ? "$provider" : UNATTRIBUTED_KEY
  }
}

/** Gộp token (theo key × provider) và credit (theo key) thành các dòng báo cáo. */
export const mergeCostRows = (
  groupBy: AiCostGroupBy,
  tokenGroups: TokenGroup[],
  creditGroups: CreditGroup[],
  labels: Map<string, string> = new Map()
): { rows: AiCostRow[]; totals: Omit<AiCostRow, "key" | "label"> } => {
  const rows = new Map<string, AiCostRow>()
  const rowOf = (key: string) => {
    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        label: labels.get(key) ?? key,
        calls: 0,
        failedCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        credits: 0,
        estimatedUsd: 0
      }
      rows.set(key, row)
    }
    return row
  }

  for (const g of tokenGroups) {
    const row = rowOf(g.key)
    row.calls += g.calls
    row.failedCalls += g.failedCalls
    row.promptTokens += g.promptTokens
    row.completionTokens += g.completionTokens
    row.estimatedUsd += estimateUsd(g.provider, g.promptTokens, g.completionTokens)
  }
  for (const g of creditGroups) {
    rowOf(g.key).credits += g.credits
  }

  const list = [...rows.values()].map((r) => ({ ...r, estimatedUsd: roundUsd(r.estimatedUsd) }))
  list.sort((a, b) =>
    groupBy === "day" ? a.key.localeCompare(b.key) : b.credits - a.credits || b.calls - a.calls
  )

  const totals = list.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      failedCalls: acc.failedCalls + r.failedCalls,
      promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens,
      credits: acc.credits + r.credits,
      estimatedUsd: acc.estimatedUsd + r.estimatedUsd
    }),
    { calls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, credits: 0, estimatedUsd: 0 }
  )
  totals.estimatedUsd = roundUsd(totals.estimatedUsd)

  return { rows: list, totals }
}

export const getAiCost = async (range: { from: Date; to: Date }, groupBy: AiCostGroupBy) => {
  const createdAt = { $gte: range.from, $lt: range.to }

  const tokenPipeline: PipelineStage[] = [
    { $match: { createdAt } },
    {
      $group: {
        _id: { key: groupKeyExpr(groupBy, "log"), provider: "$provider" },
        calls: { $sum: 1 },
        failedCalls: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
        completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } }
      }
    }
  ]

  // Chỉ dòng deduct là credit thực trừ; reservation bị hoàn không sinh deduct.
  const creditPipeline: PipelineStage[] = [
    { $match: { type: "deduct", state: { $ne: "refunded" }, createdAt } },
    { $group: { _id: groupKeyExpr(groupBy, "credit"), credits: { $sum: "$amount" } } }
  ]

  const [tokenRaw, creditRaw] = await Promise.all([
    AiActionLog.aggregate<{ _id: { key: string | null; provider: string }; calls: number; failedCalls: number; promptTokens: number; completionTokens: number }>(tokenPipeline),
    CreditTransaction.aggregate<{ _id: string | null; credits: number }>(creditPipeline)
  ])

  const tokenGroups: TokenGroup[] = tokenRaw.map((r) => ({
    key: r._id.key ?? "unknown",
    provider: r._id.provider,
    calls: r.calls,
    failedCalls: r.failedCalls,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens
  }))
  const creditGroups: CreditGroup[] = creditRaw.map((r) => ({ key: r._id ?? "unknown", credits: r.credits }))

  const labels = new Map<string, string>([[UNATTRIBUTED_KEY, "Không xác định provider"]])
  if (groupBy === "user") {
    const ids = [...new Set([...tokenGroups, ...creditGroups].map((g) => g.key))].filter((id) =>
      mongoose.isValidObjectId(id)
    )
    const users = await User.find({ _id: { $in: ids } }, { email: 1 }).lean()
    users.forEach((u) => labels.set(String(u._id), u.email))
  }

  const { rows, totals } = mergeCostRows(groupBy, tokenGroups, creditGroups, labels)

  return {
    from: range.from,
    to: range.to,
    groupBy,
    currency: "USD",
    pricingNote: "estimatedUsd là ước tính theo bảng giá tạm, không phải hoá đơn provider",
    rows,
    totals
  }
}

// ─── Feedback ─────────────────────────────────────────────────────

// Dữ liệu và shape nằm ở module feedback; admin chỉ mở route đọc
export const listFeedback = () => feedbackService.listFeedback()

// ─── UC-90 Danh sách tổ chức ─────────────────────────────────────

export interface AdminOrgRow {
  id: string
  name: string
  owner: { id: string; email: string; name: string | null } | null
  plan: PlanId
  planLabel: string
  /** null = org có trước task-26 chưa có ví; UC-68 sẽ tạo khi admin điều chỉnh lần đầu. */
  wallet: { balance: number; reserved: number; available: number } | null
  membersCount: number
  /** Dự án chưa xoá (`archived` không tính) — cùng cách đếm với trần dự án UC-16. */
  projectsCount: number
  createdAt: Date
}

/**
 * UC-90 — Administrator xem mọi tổ chức để chọn một org rồi điều chỉnh credit (UC-68).
 * Không có gói active ⇒ coi là Free, khớp với `assertProjectQuota` và `billing.getBalance`.
 */
export const listOrgs = async (query: OrgsQuery) => {
  const { page, limit, plan, q } = query
  const filter: Record<string, unknown> = {}

  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i")
    const owners = await User.find({ email: pattern }).select("_id").lean()
    filter.$or = [{ name: pattern }, { ownerUserId: { $in: owners.map((u) => u._id) } }]
  }
  if (plan) {
    // Free = không có gói trả phí active (kể cả org chưa có Subscription nào).
    const paidOrgIds = await Subscription.distinct("organizationId", {
      status: "active",
      plan: { $ne: "free" },
      organizationId: { $type: "objectId" }
    })
    filter._id = plan === "free" ? { $nin: paidOrgIds } : { $in: paidOrgIds }
  }

  const [total, orgs] = await Promise.all([
    Organization.countDocuments(filter),
    Organization.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("_id name ownerUserId createdAt")
      .lean()
  ])

  const orgIds = orgs.map((o) => o._id)
  const byOrg = { $match: { organizationId: { $in: orgIds } } }
  const [owners, subscriptions, wallets, memberCounts, projectCounts] = await Promise.all([
    User.find({ _id: { $in: orgs.map((o) => o.ownerUserId) } }).select("_id email name").lean(),
    Subscription.find({ organizationId: { $in: orgIds }, status: "active" }).select("organizationId plan").lean(),
    CreditWallet.find({ organizationId: { $in: orgIds } }).select("organizationId balance reserved").lean(),
    Membership.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      byOrg,
      { $group: { _id: "$organizationId", count: { $sum: 1 } } }
    ]),
    Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { organizationId: { $in: orgIds }, status: { $ne: "archived" } } },
      { $group: { _id: "$organizationId", count: { $sum: 1 } } }
    ])
  ])
  const ownerById = new Map(owners.map((u) => [String(u._id), u]))
  const planByOrg = new Map(subscriptions.map((s) => [String(s.organizationId), s.plan]))
  const walletByOrg = new Map(wallets.map((w) => [String(w.organizationId), w]))
  const members = new Map(memberCounts.map((r) => [String(r._id), r.count]))
  const projects = new Map(projectCounts.map((r) => [String(r._id), r.count]))

  const items: AdminOrgRow[] = orgs.map((o) => {
    const id = String(o._id)
    const owner = ownerById.get(String(o.ownerUserId))
    const wallet = walletByOrg.get(id)
    const orgPlan = planByOrg.get(id) ?? "free"
    return {
      id,
      name: o.name,
      owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name ?? null } : null,
      plan: orgPlan,
      planLabel: getPlan(orgPlan).label,
      wallet: wallet
        ? { balance: wallet.balance, reserved: wallet.reserved, available: wallet.balance - wallet.reserved }
        : null,
      membersCount: members.get(id) ?? 0,
      projectsCount: projects.get(id) ?? 0,
      createdAt: o.createdAt
    }
  })

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

// ─── UC-68 Điều chỉnh credit của tổ chức ─────────────────────────

export interface AdjustOrgCreditsResult {
  organizationId: string
  organizationName: string
  amount: number
  balance: number
  reserved: number
  reason: string
}

/**
 * UC-68 — Administrator cộng (amount > 0) hoặc trừ (amount < 0) credit trong ví của MỘT TỔ CHỨC, bắt buộc
 * kèm lý do. Lý do lưu thẳng vào dòng ledger (`type: "admin_adjust"`) để sau này còn truy được vì sao.
 *
 * Không cho số dư xuống âm, và không đụng `reserved`: phần đang giữ thuộc về các lượt gọi AI đang chạy,
 * admin trừ vào đó sẽ làm hỏng vòng reserve/settle.
 */
export const adjustOrgCredits = async (
  orgId: string,
  amount: number,
  reason: string
): Promise<AdjustOrgCreditsResult> => {
  if (!mongoose.isValidObjectId(orgId)) {
    throw new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")
  }
  const org = await Organization.findById(orgId).select("_id name ownerUserId").lean()
  if (!org) {
    throw new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")
  }

  // Ví tạo cùng org (Flow 8.2); org có trước task-26 thì chưa có ⇒ tạo tại chỗ để admin vẫn thao tác được.
  const existing = await CreditWallet.findOne({ organizationId: orgId })
  if (!existing) {
    await CreditWallet.create({ organizationId: orgId, userId: org.ownerUserId, balance: 0, reserved: 0 })
  }

  // Trừ: chỉ chạm phần KHẢ DỤNG (balance - reserved) và làm trong một lệnh atomic.
  const filter =
    amount < 0
      ? { organizationId: orgId, $expr: { $gte: [{ $subtract: ["$balance", "$reserved"] }, -amount] } }
      : { organizationId: orgId }
  const wallet = await CreditWallet.findOneAndUpdate(
    filter,
    { $inc: { balance: amount } },
    { returnDocument: "after" }
  )
  if (!wallet) {
    throw new ApiError(409, "Số dư khả dụng của tổ chức không đủ để trừ", "INSUFFICIENT_CREDIT")
  }

  await CreditTransaction.create({
    userId: org.ownerUserId ?? wallet.userId,
    organizationId: wallet.organizationId,
    projectId: null,
    actionType: "admin_adjust",
    amount: Math.abs(amount),
    type: "admin_adjust",
    balanceAfter: wallet.balance - wallet.reserved,
    reason
  })

  // Lead của org cần biết ví vừa bị ai đó ngoài tổ chức thay đổi.
  const leads = await Membership.find({ organizationId: orgId, role: "lead" }).select("userId").lean()
  for (const lead of leads) {
    void notify(String(lead.userId), {
      type: "credits_adjusted",
      title: amount >= 0 ? "Tổ chức được cộng credit" : "Tổ chức bị trừ credit",
      body: `${amount >= 0 ? "+" : ""}${amount} credit cho ${org.name}. Lý do: ${reason}`,
      organizationId: orgId,
      link: "/home/billing",
      meta: { organizationId: orgId, amount, reason }
    })
  }

  return {
    organizationId: orgId,
    organizationName: org.name,
    amount,
    balance: wallet.balance,
    reserved: wallet.reserved,
    reason
  }
}
