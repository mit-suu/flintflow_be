/**
 * FLF-400 — chống trùng tin user trong cùng phiên: FE cũ / mạng chập chờn gửi cùng một tin hai lần liền (bấm Gửi hai lần,
 * request bị gửi lại) ⇒ transcript lặp tin và tốn thêm một lượt gọi AI. Tin trùng = cùng phiên + cùng bước + cùng nội dung,
 * tới khi lượt đầu còn đang xử lý, hoặc (nơi gọi chọn `release(true)`) chưa quá `DUPLICATE_WINDOW_MS` sau khi lượt đó xong.
 *
 * Chat (lượt gọi AI mất vài giây) chỉ chặn lúc lượt đầu còn chạy; ghi transcript của step (xong trong vài ms) giữ thêm cửa
 * sổ để bản gửi lại tới muộn vẫn bị chặn. Lỗi ⇒ nhả ngay để thử lại được. Giữ trong bộ nhớ
 * tiến trình như khoá step (`acquireStepLock`) — cùng giả định single-instance; hai lần gửi liền tay tới gần như cùng
 * lúc nên đọc rồi ghi Mongo không chặn được (cả hai cùng đọc thấy phiên chưa có tin).
 */
export const DUPLICATE_WINDOW_MS = 3_000

/** `until === null`: lượt đầu còn đang xử lý. */
const claims = new Map<string, { until: number | null }>()

const keyOf = (sessionId: string, step: string, content: string): string => JSON.stringify([sessionId, step, content.trim()])

export interface UserMessageClaim {
  /** `keepWindow` ⇒ giữ thêm `DUPLICATE_WINDOW_MS` (bản gửi lại tới muộn vẫn bị chặn); không ⇒ nhả ngay. Gọi lại không sao. */
  release: (keepWindow: boolean) => void
}

/**
 * Giữ chỗ cho một tin user. `null` ⇒ tin trùng (lượt đầu còn chạy hoặc vừa xong): nơi gọi không ghi tin, không gọi AI.
 */
export const claimUserMessage = (sessionId: string, step: string, content: string, now: number = Date.now()): UserMessageClaim | null => {
  for (const [key, claim] of claims) if (claim.until !== null && claim.until <= now) claims.delete(key)
  const key = keyOf(sessionId, step, content)
  if (claims.has(key)) return null
  const claim: { until: number | null } = { until: null }
  claims.set(key, claim)
  let released = false
  return {
    release: (keepWindow) => {
      if (released) return
      released = true
      if (claims.get(key) !== claim) return
      if (keepWindow) claim.until = Date.now() + DUPLICATE_WINDOW_MS
      else claims.delete(key)
    }
  }
}

/** Chỉ cho test: xoá mọi chỗ đang giữ. */
export const resetUserMessageClaims = (): void => claims.clear()
