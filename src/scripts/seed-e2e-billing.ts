/**
 * seed-e2e-billing.ts
 * ─────────────────────────────────────────────────────────────────
 * Dữ liệu E2E cho luồng Billing / Credit / RBAC (Viewer, Analyst, Lead, Admin).
 * Gọi idempotent qua `npm run seed:e2e-billing` — luôn dựng lại đúng trạng thái ban đầu.
 */
import mongoose from "mongoose"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { Organization } from "../modules/organization/organization.model.js"
import { Membership } from "../modules/organization/membership.model.js"
import { markOnboarded } from "../modules/organization/onboarding.js"
import { createOrganization } from "../modules/organization/organization.service.js"
import { CreditWallet } from "../modules/credits/credit-wallet.model.js"
import { Subscription } from "../modules/credits/subscription.model.js"
import { CreditTransaction } from "../modules/credits/credit-transaction.model.js"
import { PaymentIntent } from "../modules/billing/payment-intent.model.js"
import { CreditTopupRequest } from "../modules/billing/credit-topup-request.model.js"
import { Project } from "../modules/project/project.model.js"
import { Notification } from "../modules/notification/notification.model.js"

const ORG_NAME = "E2E Billing Studio"
const PASSWORD = "Password123!"

const EMAILS = {
  admin: "e2e.admin@flintflow.local",
  lead: "e2e.lead@flintflow.local",
  analyst: "e2e.analyst@flintflow.local",
  viewer: "e2e.viewer@flintflow.local"
} as const

const main = async () => {
  await connectDB()
  try {
    const existingOrgs = await Organization.find({ name: ORG_NAME }).select("_id").lean()
    const orgIds = existingOrgs.map((o) => o._id)
    if (orgIds.length > 0) {
      await Promise.all([
        CreditTransaction.deleteMany({ organizationId: { $in: orgIds } }),
        PaymentIntent.deleteMany({ organizationId: { $in: orgIds } }),
        CreditTopupRequest.deleteMany({ organizationId: { $in: orgIds } }),
        Notification.deleteMany({ organizationId: { $in: orgIds } }),
        Project.deleteMany({ organizationId: { $in: orgIds } }),
        Subscription.deleteMany({ organizationId: { $in: orgIds } }),
        CreditWallet.deleteMany({ organizationId: { $in: orgIds } }),
        Membership.deleteMany({ organizationId: { $in: orgIds } }),
        Organization.deleteMany({ _id: { $in: orgIds } })
      ])
    }

    const existingUsers = await User.find({ email: { $in: Object.values(EMAILS) } })
      .select("_id")
      .lean()
    if (existingUsers.length > 0) {
      const userIds = existingUsers.map((u) => u._id)
      await Promise.all([
        Notification.deleteMany({ userId: { $in: userIds } }),
        Membership.deleteMany({ userId: { $in: userIds } }),
        User.deleteMany({ _id: { $in: userIds } })
      ])
    }

    const now = new Date()
    const [admin, lead, analyst, viewer] = await Promise.all([
      User.create({
        email: EMAILS.admin,
        password: PASSWORD,
        name: "E2E Admin",
        role: "admin",
        emailVerified: true,
        emailVerifiedAt: now,
        locale: "vi"
      }),
      User.create({
        email: EMAILS.lead,
        password: PASSWORD,
        name: "E2E Lead",
        role: "user",
        emailVerified: true,
        emailVerifiedAt: now,
        locale: "vi"
      }),
      User.create({
        email: EMAILS.analyst,
        password: PASSWORD,
        name: "E2E Analyst",
        role: "user",
        emailVerified: true,
        emailVerifiedAt: now,
        locale: "vi"
      }),
      User.create({
        email: EMAILS.viewer,
        password: PASSWORD,
        name: "E2E Viewer",
        role: "user",
        emailVerified: true,
        emailVerifiedAt: now,
        locale: "vi"
      })
    ])

    const org = await createOrganization(String(lead._id), ORG_NAME)
    const orgId = new mongoose.Types.ObjectId(org.id)

    await Membership.create([
      { organizationId: orgId, userId: analyst._id, role: "analyst", joinedAt: now },
      { organizationId: orgId, userId: viewer._id, role: "viewer", joinedAt: now }
    ])
    await Promise.all([markOnboarded(String(analyst._id)), markOnboarded(String(viewer._id))])

    // balance = 435, reserved = 15 => available = 420
    await CreditWallet.updateOne({ organizationId: orgId }, { $set: { balance: 435, reserved: 15 } })

    const project = await Project.create({
      userId: lead._id,
      organizationId: orgId,
      name: "E2E Core SRS",
      status: "active",
      mode: "fpt",
      domain: "Software"
    })

    const succeededIntent = await PaymentIntent.create({
      userId: lead._id,
      organizationId: orgId,
      packageId: "pack_100",
      credits: 100,
      amount: 40_000,
      currency: "VND",
      provider: "payment_service",
      status: "succeeded",
      paymentOrderId: "ORD-E2E-100",
      referenceCode: "REF-E2E-100",
      paymentDescription: "FF E2E100",
      processedAt: new Date(now.getTime() - 60_000)
    })

    await PaymentIntent.create({
      userId: lead._id,
      organizationId: orgId,
      packageId: "pack_500",
      credits: 500,
      amount: 199_000,
      currency: "VND",
      provider: "payment_service",
      status: "pending",
      paymentOrderId: "ORD-E2E-500",
      paymentDescription: "FF E2E500"
    })

    await CreditTransaction.create([
      {
        userId: lead._id,
        organizationId: orgId,
        projectId: null,
        actionType: "purchase",
        amount: 100,
        type: "purchase",
        balanceAfter: 400,
        intentId: succeededIntent._id,
        packageId: "pack_100",
        price: 40_000,
        currency: "VND",
        referenceCode: "REF-E2E-100",
        createdAt: new Date(now.getTime() - 50_000)
      },
      {
        userId: analyst._id,
        organizationId: orgId,
        projectId: project._id,
        actionType: "draft",
        amount: 6,
        type: "deduct",
        balanceAfter: 394,
        stepId: "S-1.1",
        tokensIn: 1200,
        tokensOut: 450,
        createdAt: new Date(now.getTime() - 40_000)
      },
      {
        userId: lead._id,
        organizationId: orgId,
        projectId: null,
        actionType: "admin_adjust",
        amount: 50,
        direction: "credit",
        type: "admin_adjust",
        balanceAfter: 444,
        reason: "Support bonus",
        createdAt: new Date(now.getTime() - 30_000)
      },
      {
        userId: lead._id,
        organizationId: orgId,
        projectId: null,
        actionType: "admin_adjust",
        amount: 15,
        direction: "debit",
        type: "admin_adjust",
        balanceAfter: 429,
        reason: "Manual correction",
        createdAt: new Date(now.getTime() - 20_000)
      }
    ])

    await Notification.create([
      {
        userId: lead._id,
        organizationId: orgId,
        type: "credits_adjusted",
        title: "Tổ chức được cộng credit",
        body: "+50 credit cho E2E Billing Studio. Lý do: Support bonus",
        link: "/home/billing",
        meta: { organizationId: org.id, organizationName: ORG_NAME, amount: 50, reason: "Support bonus" },
        createdAt: new Date(now.getTime() - 40_000)
      },
      {
        userId: lead._id,
        organizationId: orgId,
        type: "credits_adjusted",
        title: "Tổ chức bị trừ credit",
        body: "-15 credit cho E2E Billing Studio. Lý do: Manual correction",
        link: "/home/billing",
        meta: { organizationId: org.id, organizationName: ORG_NAME, amount: -15, reason: "Manual correction" },
        createdAt: new Date(now.getTime() - 30_000)
      },
      {
        userId: lead._id,
        organizationId: orgId,
        type: "payment_success",
        title: "Thanh toán thành công",
        body: "Đã cộng 100 credit vào tài khoản của bạn.",
        link: "/home/billing",
        meta: { credits: 100, amount: 40_000 },
        createdAt: new Date(now.getTime() - 20_000)
      },
      {
        userId: lead._id,
        organizationId: orgId,
        type: "low_credit",
        title: "Sắp hết credit",
        body: "Số dư của bạn chỉ còn 8 credit. Nạp thêm để tiếp tục dùng AI.",
        link: "/home/billing",
        meta: { balance: 8, threshold: 10 },
        createdAt: new Date(now.getTime() - 10_000)
      }
    ])

    console.log(
      `Seeded E2E Billing data: org=${org.id} admin=${admin.email} lead=${lead.email} analyst=${analyst.email} viewer=${viewer.email} project=${project._id}`
    )
  } finally {
    await mongoose.disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
