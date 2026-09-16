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
 */
import mongoose from "mongoose"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { CreditWallet } from "../modules/credits/credit-wallet.model.js"

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

  const wallet = await CreditWallet.findOne({ userId: user._id })
  if (!wallet) {
    await CreditWallet.create({ userId: user._id, balance: args.credits, reserved: 0 })
    console.log(`[seed-e2e-user] ví mới: ${args.credits} credit`)
  } else if (wallet.balance < args.credits) {
    wallet.balance = args.credits
    await wallet.save()
    console.log(`[seed-e2e-user] nâng ví lên ${args.credits} credit`)
  } else {
    console.log(`[seed-e2e-user] ví giữ nguyên: ${wallet.balance} credit`)
  }

  console.log(`[seed-e2e-user] xong — ${email} / userId=${String(user._id)}`)
  await mongoose.disconnect()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
