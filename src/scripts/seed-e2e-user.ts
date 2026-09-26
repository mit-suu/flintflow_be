/**
 * seed-e2e-user.ts (T24)
 * ─────────────────────────────────────────────────────────────────
 * Tạo (hoặc sửa) một tài khoản dùng được ngay cho e2e / smoke test.
 *
 *   npm run seed:e2e-user -- --email fixture@flintflow.io --password fixture-password-123
 *
 * Vì sao không dùng `POST /auth/register`: `login` từ chối tài khoản `emailVerified: false` với
 * `403 EMAIL_NOT_VERIFIED`, mà register thì gửi mail xác thực — trong CI không có hộp thư nào để bấm.
 * Script này đặt thẳng `emailVerified: true` và nạp ví credit, nên kịch bản e2e đăng nhập được ngay.
 *
 * Chạy lại được: tài khoản đã có thì đặt lại mật khẩu, bật verified và nâng ví lên `--credits`.
 *
 * task-26: mọi tài nguyên đều thuộc TỔ CHỨC. Tài khoản không thuộc org nào sẽ bị FE đẩy sang màn onboarding
 * ngay sau khi đăng nhập ⇒ e2e hỏng. Vì vậy tài khoản thường được đảm bảo là Lead của một org, và ví được nạp
 * là ví của org đó (lượt gọi AI trừ vào ví của org sở hữu dự án).
 */
import mongoose from "mongoose"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { CreditWallet } from "../modules/credits/credit-wallet.model.js"
import { Membership } from "../modules/organization/membership.model.js"
import { createOrganization } from "../modules/organization/organization.service.js"

interface Args {
  email: string
  password: string
  name: string
  credits: number
  role: "user" | "admin"
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const args: Args = {
    email: process.env.E2E_EMAIL ?? "fixture@flintflow.io",
    password: process.env.E2E_PASSWORD ?? "fixture-password-123",
    name: "E2E Fixture",
    credits: 1000,
    role: "user"
  }
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] as string
    switch (argv[i]) {
      case "--email":
        args.email = next()
        break
      case "--password":
        args.password = next()
        break
      case "--name":
        args.name = next()
        break
      case "--credits":
        args.credits = Number(next())
        break
      case "--role":
        args.role = next() === "admin" ? "admin" : "user"
        break
      default:
        throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  return args
}

const main = async (): Promise<void> => {
  const args = parseArgs()
  await connectDB()

  const email = args.email.toLowerCase().trim()
  let user = await User.findOne({ email })
  if (user) {
    // `password` là virtual/setter băm ở model — gán rồi save, không ghi thẳng passwordHash.
    user.set({ password: args.password, emailVerified: true, emailVerifiedAt: new Date(), role: args.role })
    await user.save()
    console.log(`[seed-e2e-user] cập nhật ${email}`)
  } else {
    user = await User.create({
      email,
      password: args.password,
      name: args.name,
      role: args.role,
      emailVerified: true,
      emailVerifiedAt: new Date()
    })
    console.log(`[seed-e2e-user] tạo mới ${email}`)
  }

  const userId = String(user._id)
  let organizationId: string | null = null
  if (args.role !== "admin") {
    const membership = await Membership.findOne({ userId: user._id }).lean()
    if (membership) {
      organizationId = String(membership.organizationId)
    } else {
      // Cùng đường với người dùng thật: org + Lead + ví + gói free + onboardedAt
      organizationId = (await createOrganization(userId, args.name + "'s Organization")).id
      console.log(`[seed-e2e-user] tạo tổ chức ${organizationId}`)
    }
  }

  // Có org ⇒ ví của org; admin không thuộc org ⇒ ví cá nhân như trước.
  const wallet = await CreditWallet.findOne(organizationId ? { organizationId } : { userId: user._id })
  if (!wallet) {
    await CreditWallet.create({ userId: user._id, organizationId, balance: args.credits, reserved: 0 })
    console.log(`[seed-e2e-user] ví mới: ${args.credits} credit`)
  } else if (wallet.balance < args.credits) {
    wallet.balance = args.credits
    await wallet.save()
    console.log(`[seed-e2e-user] nâng ví lên ${args.credits} credit`)
  } else {
    console.log(`[seed-e2e-user] ví giữ nguyên: ${wallet.balance} credit`)
  }

  console.log(`[seed-e2e-user] xong — ${email} / userId=${userId}${organizationId ? " / orgId=" + organizationId : ""}`)
  await mongoose.disconnect()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
