import mongoose from "mongoose"
import { CreditWallet } from "./credit-wallet.model.js"
import { Subscription } from "./subscription.model.js"

interface IndexInfo {
  name?: string
  unique?: boolean
  partialFilterExpression?: unknown
}

interface LegacyRule {
  collection: string
  name: string
  /** true ⇒ index đang có trong DB lệch với schema hiện tại, phải gỡ để dựng lại. */
  isLegacy: (index: IndexInfo) => boolean
}

const orgKeyIsWrong = (index: IndexInfo) => !(index.unique === true && index.partialFilterExpression)

/**
 * Index trong DB lệch với schema của task-26. Mongoose KHÔNG BAO GIỜ tự sửa index đã có — `autoIndex` chỉ tạo
 * index còn thiếu, và khi trùng tên với index khác định nghĩa thì bỏ qua trong im lặng. Hai kiểu lệch đã gặp
 * thật trên `flintflow_v2` (2026-09-26):
 *
 * - `userId_1` còn **unique** (từ thời một người một ví) ⇒ tạo org thứ hai của cùng một người nổ `E11000`.
 * - `organizationId_1` là index **thường** (sót từ một phiên bản schema trung gian) ⇒ partial unique index
 *   "mỗi org đúng một ví / một gói" không bao giờ được tạo, ràng buộc đó mất hiệu lực.
 */
export const LEGACY_INDEX_RULES: readonly LegacyRule[] = [
  { collection: CreditWallet.collection.name, name: "userId_1", isLegacy: (i) => i.unique === true },
  { collection: Subscription.collection.name, name: "userId_1", isLegacy: (i) => i.unique === true },
  { collection: CreditWallet.collection.name, name: "organizationId_1", isLegacy: orgKeyIsWrong },
  { collection: Subscription.collection.name, name: "organizationId_1", isLegacy: orgKeyIsWrong }
]

/**
 * Gỡ các index lệch ở trên rồi dựng lại đúng theo schema. Chỉ đụng index, không đụng dữ liệu; chạy lại không
 * đổi gì. Dry-run chỉ trả danh sách sẽ gỡ.
 *
 * Được gọi lúc khởi động (`connectDB`) và trong `migrate:orgs`: bản sửa trước chỉ nằm trong script chạy tay,
 * bước đó bị bỏ qua thì code mới cứ lỗi mãi.
 */
export const repairLegacyIndexes = async (dryRun = false): Promise<string[]> => {
  const db = mongoose.connection
  const repaired: string[] = []
  for (const rule of LEGACY_INDEX_RULES) {
    let indexes: IndexInfo[] = []
    try {
      indexes = await db.collection(rule.collection).indexes()
    } catch {
      continue // collection chưa tồn tại ⇒ chưa có index nào để gỡ
    }
    const found = indexes.find((index) => index.name === rule.name)
    if (!found || !rule.isLegacy(found)) continue
    if (!dryRun) await db.collection(rule.collection).dropIndex(rule.name)
    repaired.push(rule.collection + "." + rule.name)
  }
  if (!dryRun && repaired.length > 0) {
    await Promise.all([CreditWallet.createIndexes(), Subscription.createIndexes()])
  }
  return repaired
}
