/**
 * Xoá ví credit cá nhân (`organizationId = null`) còn sót từ trước task-26, chạy một lần (FLF-310).
 *
 * Cách dùng:
 *   npm run migrate:personal-wallets             # mặc định chạy thử: chỉ liệt kê, không xoá
 *   npm run migrate:personal-wallets -- --apply  # xoá thật
 *
 * Vì sao: từ task-26 credit chỉ nằm ở ví tổ chức (lượt gọi AI trừ ví org sở hữu project / org đang chọn). Ví cá nhân
 * không còn dùng được nhưng `GET /users/me` cũ vẫn đọc nó ⇒ trang hồ sơ báo sai "Credit hiện có".
 *
 * Giữ nguyên lịch sử giao dịch (`credittransactions`) — chỉ xoá ví. Ví của người còn lượt giữ credit cá nhân đang chạy
 * (reserve `state = reserved`, không org) thì bỏ qua và báo ra; chạy lại sau khi lượt đó xong. Riêng `reserved > 0` mà
 * không có lượt giữ nào là số lệch còn sót (gặp trên DB dev) — vẫn xoá.
 */
import { pathToFileURL } from "node:url"

export interface PersonalWallet {
  _id: unknown
  userId: unknown
  balance: number
  reserved: number
  updatedAt?: Date | null
}

export interface CleanupPlan {
  remove: PersonalWallet[]
  /** Người dùng còn lượt giữ credit cá nhân đang chạy — không xoá lần này. */
  skipped: PersonalWallet[]
  /** Tổng số dư sẽ bị bỏ cùng các ví xoá (credit cá nhân không còn dùng được). */
  droppedBalance: number
}

/** `liveHolders`: userId còn reservation cá nhân `state = reserved`. */
export const planPersonalWalletCleanup = (wallets: readonly PersonalWallet[], liveHolders: ReadonlySet<string> = new Set()): CleanupPlan => {
  const live = (w: PersonalWallet) => liveHolders.has(String(w.userId))
  const remove = wallets.filter((w) => !live(w))
  const skipped = wallets.filter(live)
  return { remove, skipped, droppedBalance: remove.reduce((sum, w) => sum + (w.balance ?? 0), 0) }
}

const main = async (): Promise<void> => {
  const apply = process.argv.slice(2).includes("--apply")
  const [{ default: mongoose }, { env }, { CreditWallet }, { CreditTransaction }] = await Promise.all([
    import("mongoose"),
    import("../config/env.js"),
    import("../modules/credits/credit-wallet.model.js"),
    import("../modules/credits/credit-transaction.model.js")
  ])
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${apply ? "" : " (chạy thử: không xoá — thêm --apply để xoá thật)"}`)
  try {
    const wallets = await CreditWallet.find({ organizationId: null }, { userId: 1, balance: 1, reserved: 1, updatedAt: 1 }).lean<PersonalWallet[]>()
    const holders = await CreditTransaction.distinct("userId", { type: "reserve", state: "reserved", organizationId: null })
    const plan = planPersonalWalletCleanup(wallets, new Set(holders.map(String)))
    for (const w of plan.remove) {
      console.log(`  - ví ${String(w._id)} · user ${String(w.userId)} · số dư ${w.balance} · cập nhật ${w.updatedAt?.toISOString() ?? "?"}`)
    }
    for (const w of plan.skipped) console.warn(`  ! bỏ qua ví ${String(w._id)} (user ${String(w.userId)}): còn lượt giữ credit đang chạy`)
    if (apply && plan.remove.length) {
      const res = await CreditWallet.deleteMany({ _id: { $in: plan.remove.map((w) => String(w._id)) }, organizationId: null })
      console.log(`Đã xoá ${res.deletedCount} ví cá nhân (bỏ ${plan.droppedBalance} credit không còn dùng được), bỏ qua ${plan.skipped.length}.`)
    } else {
      console.log(`${apply ? "Không có" : "Chạy thử: sẽ xoá"} ${plan.remove.length} ví cá nhân (${plan.droppedBalance} credit), bỏ qua ${plan.skipped.length}.`)
    }
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("❌ Xoá ví cá nhân lỗi:", err)
    process.exit(1)
  })
}
