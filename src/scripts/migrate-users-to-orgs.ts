/**
 * task-26 Pha 0 — tạo "personal org" cho mọi user có trước khi hệ thống có Organization, rồi gắn dữ liệu
 * của họ vào org đó.
 *
 * Cách dùng:
 *   npm run migrate:orgs -- --dry-run                      # chỉ đếm, không ghi
 *   npm run migrate:orgs
 *   npm run migrate:orgs -- --report docs/migration-org-report.md
 *
 * Nguyên tắc:
 * - Mỗi user thành một org 1 thành viên và chính họ là Lead — đúng mô hình "làm một mình = org 1 thành
 *   viên" (context/business-flow.md §2), nên không ai mất dữ liệu và không phải chuyển thủ công.
 * - Backfill bằng driver thô (như migrate-mode1-defaults.ts): không chạy validator của schema hiện tại,
 *   document cũ thiếu field mới vẫn cập nhật được.
 * - Idempotent: org tìm lại qua ownerUserId, Membership dùng upsert (đã có unique index), và mọi backfill
 *   chỉ khớp organizationId = null ⇒ chạy lần hai không đổi gì.
 * - KHÔNG chạm spines: Spine gắn với projectId, mà project đã có org ⇒ kế thừa. Ghi Spine ngoài op-engine
 *   là điều cấm (coding-rules.md §3).
 * - Thông báo cấp nền tảng (admin_new_user) giữ organizationId = null: chúng gửi cho Administrator về toàn
 *   hệ thống, không thuộc org nào.
 */
import fs from "node:fs"
import path from "node:path"
import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Organization, ORG_NAME_MAX } from "../modules/organization/organization.model.js"
import { Membership } from "../modules/organization/membership.model.js"
import { Project } from "../modules/project/project.model.js"
import { Folder } from "../modules/folder/folder.model.js"
import { CreditWallet } from "../modules/credits/credit-wallet.model.js"
import { Subscription } from "../modules/credits/subscription.model.js"
import { CreditTransaction } from "../modules/credits/credit-transaction.model.js"
import { Notification } from "../modules/notification/notification.model.js"
import { repairLegacyIndexes } from "../modules/credits/legacy-indexes.js"

/** Cùng mẫu với tên gợi ý ở màn tạo tổ chức của FE (yêu cầu 2026-09-26): "Tien's Organization". */
const SUFFIX = "'s Organization"

/** Loại thông báo không thuộc org nào — gửi cho Administrator về toàn nền tảng. */
export const PLATFORM_NOTIFICATION_TYPES = ["admin_new_user"] as const

export interface BackfillTarget {
  collection: string
  /** Điều kiện phụ, cộng thêm vào { userId, organizationId: null }. */
  extraFilter?: Record<string, unknown>
}

/**
 * Sáu collection đổi trục sở hữu ở task-26. Lấy tên từ chính model để không lệch khi ai đó đổi
 * mongoose.model(...).
 */
export const BACKFILL_TARGETS: readonly BackfillTarget[] = [
  { collection: Project.collection.name },
  { collection: Folder.collection.name },
  { collection: CreditWallet.collection.name },
  { collection: Subscription.collection.name },
  { collection: CreditTransaction.collection.name },
  {
    collection: Notification.collection.name,
    extraFilter: { type: { $nin: [...PLATFORM_NOTIFICATION_TYPES] } }
  }
]

/** Tên org cá nhân. Ưu tiên tên hiển thị, không có thì lấy phần trước @ của email. */
export const personalOrgName = (user: { name?: string | null; email?: string | null }): string => {
  const fromName = (user.name ?? "").trim()
  const fromEmail = (user.email ?? "").split("@")[0]?.trim() ?? ""
  const base = fromName || fromEmail
  if (!base) return "My Organization"
  const full = base + SUFFIX
  if (full.length <= ORG_NAME_MAX) return full
  return base.slice(0, ORG_NAME_MAX - SUFFIX.length).trim() + SUFFIX
}

export interface MigrationStats {
  dryRun: boolean
  usersScanned: number
  /** User đã thuộc một org và không còn dữ liệu treo ⇒ bỏ qua hoàn toàn. */
  usersSkipped: number
  orgsCreated: number
  orgsReused: number
  membershipsCreated: number
  /** collection → số document được gắn organizationId. */
  backfilled: Record<string, number>
  /** collection → số document VẪN còn organizationId null sau khi chạy (phải là 0). */
  remainingNull: Record<string, number>
  /** Index unique cũ đã gỡ (dry-run: sẽ gỡ), dạng "collection.indexName". */
  indexesRepaired: string[]
}

export const emptyStats = (dryRun: boolean): MigrationStats => ({
  dryRun,
  usersScanned: 0,
  usersSkipped: 0,
  orgsCreated: 0,
  orgsReused: 0,
  membershipsCreated: 0,
  backfilled: Object.fromEntries(BACKFILL_TARGETS.map((t) => [t.collection, 0])),
  remainingNull: Object.fromEntries(BACKFILL_TARGETS.map((t) => [t.collection, 0])),
  indexesRepaired: []
})

// Sửa index lệch schema — dùng chung với lúc khởi động (`config/database.ts`).
export { LEGACY_INDEX_RULES, repairLegacyIndexes } from "../modules/credits/legacy-indexes.js"

export const buildReport = (stats: MigrationStats, finishedAt: Date): string => {
  const leftover = Object.values(stats.remainingNull).reduce((sum, n) => sum + n, 0)
  const lines = [
    "# Báo cáo migration user → organization (task-26 Pha 0)",
    "",
    "- Chạy lúc: " + finishedAt.toISOString(),
    "- Chế độ: " + (stats.dryRun ? "**dry-run** (không ghi gì)" : "ghi thật"),
    "- User quét: " + stats.usersScanned + " · bỏ qua (đã có org, không còn dữ liệu treo): " + stats.usersSkipped,
    "- Org tạo mới: " + stats.orgsCreated + " · org dùng lại: " + stats.orgsReused,
    "- Membership Lead tạo mới: " + stats.membershipsCreated,
    "- Index unique cũ " + (stats.dryRun ? "sẽ gỡ" : "đã gỡ") + ": " +
      (stats.indexesRepaired.length > 0 ? stats.indexesRepaired.join(", ") : "không có"),
    "",
    "## Backfill organizationId",
    "",
    "| Collection | Đã gắn | Còn null |",
    "| --- | ---: | ---: |"
  ]
  for (const target of BACKFILL_TARGETS) {
    const done = stats.backfilled[target.collection] ?? 0
    const left = stats.remainingNull[target.collection] ?? 0
    lines.push("| " + target.collection + " | " + done + " | " + left + " |")
  }
  lines.push("")
  lines.push(
    leftover === 0
      ? "Không còn document nào thiếu organizationId."
      : "**Còn " + leftover + " document thiếu organizationId** — xem lại trước khi sang Pha 1."
  )
  lines.push("")
  return lines.join("\n")
}

interface RunOptions {
  dryRun: boolean
}

export const migrateUsersToOrgs = async ({ dryRun }: RunOptions): Promise<MigrationStats> => {
  const stats = emptyStats(dryRun)
  const db = mongoose.connection
  // Làm TRƯỚC mọi thứ khác: còn index cũ thì code mới không tạo được org thứ hai cho cùng một người.
  stats.indexesRepaired = await repairLegacyIndexes(dryRun)
  const users = await User.find({}).select("_id name email").lean()
  stats.usersScanned = users.length

  for (const user of users) {
    const userId = user._id
    const pending = new Map<string, number>()
    for (const target of BACKFILL_TARGETS) {
      const count = await db
        .collection(target.collection)
        .countDocuments({ userId, organizationId: null, ...(target.extraFilter ?? {}) })
      pending.set(target.collection, count)
    }
    const pendingTotal = [...pending.values()].reduce((sum, n) => sum + n, 0)
    const hasMembership = (await Membership.exists({ userId })) !== null

    // Đã thuộc một org và không còn gì treo ⇒ không cần org cá nhân. Chạy lần hai rơi hết vào nhánh này.
    if (hasMembership && pendingTotal === 0) {
      stats.usersSkipped += 1
      continue
    }

    if (dryRun) {
      const existing = await Organization.exists({ ownerUserId: userId })
      if (existing) stats.orgsReused += 1
      else stats.orgsCreated += 1
      if (!hasMembership) stats.membershipsCreated += 1
      for (const [collection, count] of pending) {
        stats.backfilled[collection] = (stats.backfilled[collection] ?? 0) + count
      }
      continue
    }

    let org = await Organization.findOne({ ownerUserId: userId })
    if (org) {
      stats.orgsReused += 1
    } else {
      org = await Organization.create({ name: personalOrgName(user), ownerUserId: userId })
      stats.orgsCreated += 1
    }

    // upsert + returnDocument "before" ⇒ trả về null đúng khi vừa chèn, nên đếm được membership tạo mới.
    const existingMembership = await Membership.findOneAndUpdate(
      { organizationId: org._id, userId },
      { $setOnInsert: { role: "lead", joinedAt: new Date() } },
      { upsert: true, returnDocument: "before" }
    )
    if (!existingMembership) stats.membershipsCreated += 1

    for (const target of BACKFILL_TARGETS) {
      const result = await db
        .collection(target.collection)
        .updateMany(
          { userId, organizationId: null, ...(target.extraFilter ?? {}) },
          { $set: { organizationId: org._id } }
        )
      stats.backfilled[target.collection] = (stats.backfilled[target.collection] ?? 0) + result.modifiedCount
    }
  }

  for (const target of BACKFILL_TARGETS) {
    stats.remainingNull[target.collection] = await db
      .collection(target.collection)
      .countDocuments({ organizationId: null, ...(target.extraFilter ?? {}) })
  }

  return stats
}

const parseReportPath = (argv: readonly string[]): string => {
  const index = argv.indexOf("--report")
  const given = index === -1 ? undefined : argv[index + 1]
  return given ?? "docs/migration-org-report.md"
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  const reportPath = parseReportPath(process.argv)
  // Không dùng connectDB: nó còn dựng replica set và tài khoản admin — script không được có tác dụng phụ đó.
  await mongoose.connect(env.MONGO_URI)
  console.log("🟢 Connected to MongoDB" + (dryRun ? " (dry-run: không ghi)" : ""))
  try {
    const stats = await migrateUsersToOrgs({ dryRun })
    const report = buildReport(stats, new Date())
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, report)
    console.log(report)
    console.log("📄 Báo cáo: " + reportPath)
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
