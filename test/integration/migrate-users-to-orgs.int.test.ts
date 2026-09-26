/**
 * task-26 Pha 0 — migration user → personal org chạy trên Mongo thật (in-memory replica set).
 * Kiểm ba tính chất quan trọng nhất: dry-run không ghi, backfill đủ sáu collection, chạy lại không đổi gì.
 */
import { describe, it, expect, beforeEach } from "vitest"
import mongoose from "mongoose"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Folder } from "../../src/modules/folder/folder.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { migrateUsersToOrgs } from "../../src/scripts/migrate-users-to-orgs.js"

const seedLegacyUser = async (email: string, name: string) => {
  const user = await User.create({ email, password: "legacy-password-123", name, emailVerified: true })
  const userId = user._id
  const now = new Date()
  await Project.create({ userId, name: name + " Project", status: "active", mode: "fpt" })
  await Folder.create({ userId, name: name + " Folder", color: "violet" })
  await CreditWallet.create({ userId, balance: 100, reserved: 0 })
  await Subscription.create({
    userId,
    plan: "free",
    status: "active",
    monthlyCreditsAllotment: 100,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000)
  })
  await CreditTransaction.create({
    userId,
    actionType: "chat",
    amount: 5,
    type: "deduct",
    balanceAfter: 95
  })
  await Notification.create({ userId, type: "welcome", title: "Chào mừng" })
  return user
}

describe("migrate-users-to-orgs (integration)", () => {
  beforeEach(async () => {
    await seedLegacyUser("legacy-a@flintflow.test", "An")
    await seedLegacyUser("legacy-b@flintflow.test", "Bình")
  })

  it("dry-run đếm đúng nhưng không ghi gì", async () => {
    const stats = await migrateUsersToOrgs({ dryRun: true })

    expect(stats.usersScanned).toBe(2)
    expect(stats.orgsCreated).toBe(2)
    expect(stats.membershipsCreated).toBe(2)
    expect(stats.backfilled.projects).toBe(2)
    expect(stats.backfilled.creditwallets).toBe(2)

    expect(await Organization.countDocuments({})).toBe(0)
    expect(await Membership.countDocuments({})).toBe(0)
    expect(await Project.countDocuments({ organizationId: null })).toBe(2)
  })

  it("chạy thật: mỗi user một org, là Lead, và không còn document nào thiếu organizationId", async () => {
    const stats = await migrateUsersToOrgs({ dryRun: false })

    expect(stats.orgsCreated).toBe(2)
    expect(stats.membershipsCreated).toBe(2)
    for (const count of Object.values(stats.remainingNull)) expect(count).toBe(0)

    const orgs = await Organization.find({}).lean()
    expect(orgs).toHaveLength(2)
    expect(orgs.map((o) => o.name).sort()).toEqual(["An's Organization", "Bình's Organization"])

    const memberships = await Membership.find({}).lean()
    expect(memberships).toHaveLength(2)
    expect(memberships.every((m) => m.role === "lead")).toBe(true)

    // Dữ liệu của một user phải nằm trong đúng org của user đó
    const an = await User.findOne({ email: "legacy-a@flintflow.test" }).lean()
    const anOrg = orgs.find((o) => String(o.ownerUserId) === String(an?._id))
    const anProject = await Project.findOne({ userId: an?._id }).lean()
    expect(String(anProject?.organizationId)).toBe(String(anOrg?._id))

    expect(await Project.countDocuments({ organizationId: null })).toBe(0)
    expect(await Folder.countDocuments({ organizationId: null })).toBe(0)
    expect(await CreditWallet.countDocuments({ organizationId: null })).toBe(0)
    expect(await Subscription.countDocuments({ organizationId: null })).toBe(0)
    expect(await CreditTransaction.countDocuments({ organizationId: null })).toBe(0)
    expect(await Notification.countDocuments({ organizationId: null })).toBe(0)
  })

  it("chạy lần hai không tạo thêm gì (idempotent)", async () => {
    await migrateUsersToOrgs({ dryRun: false })
    const second = await migrateUsersToOrgs({ dryRun: false })

    expect(second.usersSkipped).toBe(2)
    expect(second.orgsCreated).toBe(0)
    expect(second.membershipsCreated).toBe(0)
    for (const count of Object.values(second.backfilled)) expect(count).toBe(0)

    expect(await Organization.countDocuments({})).toBe(2)
    expect(await Membership.countDocuments({})).toBe(2)
  })

  it("thông báo cấp nền tảng vẫn không thuộc org nào", async () => {
    const admin = await User.create({
      email: "admin@flintflow.test",
      password: "admin-password-123",
      role: "admin",
      emailVerified: true
    })
    await Notification.create({ userId: admin._id, type: "admin_new_user", title: "User mới" })

    await migrateUsersToOrgs({ dryRun: false })

    const platform = await Notification.findOne({ type: "admin_new_user" }).lean()
    expect(platform?.organizationId ?? null).toBeNull()
  })

  it("ví của org là duy nhất — partial unique index chặn ví thứ hai cùng org", async () => {
    await migrateUsersToOrgs({ dryRun: false })
    const org = await Organization.findOne({}).lean()

    await expect(
      CreditWallet.create({
        userId: new mongoose.Types.ObjectId(),
        organizationId: org?._id,
        balance: 0,
        reserved: 0
      })
    ).rejects.toThrow()
  })
})

describe("index unique cũ trên userId (lỗi E11000 khi tạo org thứ hai)", () => {
  /** Dựng lại đúng trạng thái DB có từ trước task-26: userId_1 là unique. */
  const installLegacyIndexes = async () => {
    for (const name of ["creditwallets", "subscriptions"]) {
      const collection = mongoose.connection.collection(name)
      await collection.dropIndex("userId_1").catch(() => undefined)
      await collection.createIndex({ userId: 1 }, { name: "userId_1", unique: true })
    }
  }

  const isUnique = async (name: string) =>
    (await mongoose.connection.collection(name).indexes()).find((i) => i.name === "userId_1")?.unique === true

  it("tái hiện lỗi, migration gỡ index cũ, rồi tạo org thứ hai được", async () => {
    const { createOrganization } = await import("../../src/modules/organization/organization.service.js")
    const { repairLegacyIndexes } = await import("../../src/scripts/migrate-users-to-orgs.js")
    const owner = await User.create({ email: "hai-org@flintflow.test", password: "legacy-password-123", emailVerified: true })
    const userId = String(owner._id)

    await installLegacyIndexes()
    try {
      await createOrganization(userId, "Org thứ nhất")
      // Đúng lỗi người dùng gặp: ví thứ hai cùng userId đụng index unique cũ
      await expect(createOrganization(userId, "Org thứ hai")).rejects.toMatchObject({ code: 11000 })

      const repaired = await repairLegacyIndexes(false)
      expect(repaired).toEqual(["creditwallets.userId_1", "subscriptions.userId_1"])
      expect(await isUnique("creditwallets")).toBe(false)
      expect(await isUnique("subscriptions")).toBe(false)

      await createOrganization(userId, "Org thứ hai")
      expect(await Organization.countDocuments({ ownerUserId: userId })).toBe(2)
      expect(await CreditWallet.countDocuments({ userId })).toBe(2)
    } finally {
      await repairLegacyIndexes(false)
    }
  })

  it("dry-run chỉ báo, không gỡ; chạy lần hai thì không còn gì để gỡ", async () => {
    const { repairLegacyIndexes } = await import("../../src/scripts/migrate-users-to-orgs.js")
    await installLegacyIndexes()
    try {
      expect(await repairLegacyIndexes(true)).toHaveLength(2)
      expect(await isUnique("creditwallets")).toBe(true)

      expect(await repairLegacyIndexes(false)).toHaveLength(2)
      expect(await repairLegacyIndexes(false)).toEqual([])
    } finally {
      await repairLegacyIndexes(false)
    }
  })

  it("chạy cả migration thì báo cáo có ghi index đã gỡ", async () => {
    await installLegacyIndexes()
    try {
      const stats = await migrateUsersToOrgs({ dryRun: false })
      expect(stats.indexesRepaired).toEqual(["creditwallets.userId_1", "subscriptions.userId_1"])
    } finally {
      const { repairLegacyIndexes } = await import("../../src/scripts/migrate-users-to-orgs.js")
      await repairLegacyIndexes(false)
    }
  })
})

describe("organizationId_1 là index thường (tình trạng thật trên flintflow_v2 2026-09-26)", () => {
  it("dựng lại thành partial unique ⇒ ràng buộc mỗi org một ví có hiệu lực trở lại", async () => {
    const { repairLegacyIndexes } = await import("../../src/modules/credits/legacy-indexes.js")
    const wallets = mongoose.connection.collection("creditwallets")
    await wallets.dropIndex("organizationId_1").catch(() => undefined)
    await wallets.createIndex({ organizationId: 1 }, { name: "organizationId_1" })

    try {
      const orgId = new mongoose.Types.ObjectId()
      // Index sai: ví thứ hai cho CÙNG một org vẫn lọt — đúng là ràng buộc đang mất hiệu lực
      await CreditWallet.create({ userId: new mongoose.Types.ObjectId(), organizationId: orgId, balance: 0, reserved: 0 })
      await CreditWallet.create({ userId: new mongoose.Types.ObjectId(), organizationId: orgId, balance: 0, reserved: 0 })
      await CreditWallet.deleteMany({ organizationId: orgId })

      expect(await repairLegacyIndexes()).toContain("creditwallets.organizationId_1")
      const rebuilt = (await wallets.indexes()).find((i) => i.name === "organizationId_1")
      expect(rebuilt?.unique).toBe(true)
      expect(rebuilt?.partialFilterExpression).toBeTruthy()

      await CreditWallet.create({ userId: new mongoose.Types.ObjectId(), organizationId: orgId, balance: 0, reserved: 0 })
      await expect(
        CreditWallet.create({ userId: new mongoose.Types.ObjectId(), organizationId: orgId, balance: 0, reserved: 0 })
      ).rejects.toMatchObject({ code: 11000 })
    } finally {
      await repairLegacyIndexes()
    }
  })

  it("DB đã đúng schema thì không gỡ gì", async () => {
    const { repairLegacyIndexes } = await import("../../src/modules/credits/legacy-indexes.js")
    expect(await repairLegacyIndexes()).toEqual([])
  })
})
