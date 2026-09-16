/**
 * transaction.ts
 * ─────────────────────────────────────────────────────────────────
 * Mongo transaction khi deployment hỗ trợ (replica set), báo `TRANSACTION_UNAVAILABLE` khi không
 * (Mongo standalone lúc dev, hoặc chưa kết nối — test dùng model giả). Caller tự chọn đường dự phòng
 * vì thứ tự ghi an toàn khi không có transaction khác nhau theo nghiệp vụ.
 */

import mongoose, { ClientSession } from "mongoose"

export const TRANSACTION_UNAVAILABLE = Symbol("TRANSACTION_UNAVAILABLE")

export const sessionOptions = (session?: ClientSession) => (session ? { session } : {})

export const isTransactionUnsupported = (err: unknown): boolean => {
  const e = err as { message?: unknown; code?: unknown } | null
  const message = typeof e?.message === "string" ? e.message : ""
  return (
    message.includes("replica set member") ||
    message.includes("Transaction numbers") ||
    // withTransaction trên standalone báo lỗi retryable writes thay vì transaction
    message.includes("retryable writes") ||
    e?.code === 20
  )
}

/** Đã biết server không hỗ trợ ⇒ không thử lại mỗi lần ghi. */
let unsupported = false

/**
 * Chạy `fn` trong một transaction. `fn` có thể bị driver chạy lại khi lỗi tạm thời nên không được
 * có side effect ngoài DB. Server không hỗ trợ transaction ⇒ trả `TRANSACTION_UNAVAILABLE`, không ghi gì.
 */
export const runInTransaction = async <T>(
  fn: (session: ClientSession) => Promise<T>
): Promise<T | typeof TRANSACTION_UNAVAILABLE> => {
  if (unsupported || mongoose.connection.readyState !== 1) return TRANSACTION_UNAVAILABLE

  let session: ClientSession
  try {
    session = await mongoose.startSession()
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err
    unsupported = true
    return TRANSACTION_UNAVAILABLE
  }

  try {
    let result: { value: T } | null = null
    await session.withTransaction(async () => {
      result = { value: await fn(session) }
    })
    if (result === null) throw new Error("Transaction kết thúc mà không có kết quả")
    return (result as { value: T }).value
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err
    unsupported = true
    return TRANSACTION_UNAVAILABLE
  } finally {
    await session.endSession()
  }
}
