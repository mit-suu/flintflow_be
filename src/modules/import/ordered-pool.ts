/**
 * Pool "đọc song song, ghép theo thứ tự" (FLF-392, I-4): tối đa `limit` phần tử `read` cùng lúc, lấy theo thứ tự; phần tử đọc
 * xong được `commit` nối tiếp đúng thứ tự ngay khi mọi phần tử đứng trước đã ghép (tiền tố liền mạch).
 *
 * Dừng: `read` trả `{ ok: false }` hoặc `stop` bật từ ngoài ⇒ không phần tử mới nào được lấy; các `read` đang chạy tự dừng
 * khi thấy `stop` (caller kiểm trước mỗi lượt). Tiền tố đã sẵn vẫn ghép; phần sau chỗ hỏng không ghép.
 * Lỗi: `read` / `commit` ném ⇒ bật `stop`, thôi ghép, ném lại lỗi đầu tiên. Pool chỉ trả về / ném sau khi **mọi** worker và
 * chuỗi ghép đã xong ⇒ không còn worker mồ côi khi job được thử lại.
 */

/** Tín hiệu dừng chung giữa pool và các worker. */
export interface PoolStop {
  aborted: boolean
}

export type PoolRead<R> = { ok: true; value: R } | { ok: false }

export interface OrderedPoolResult {
  /** Số phần tử đầu đã ghép. */
  committed: number
}

export const runOrdered = async <T, R>(
  items: readonly T[],
  limit: number,
  opts: {
    read: (item: T, index: number) => Promise<PoolRead<R>>
    commit: (item: T, value: R, index: number) => Promise<void>
    stop: PoolStop
  }
): Promise<OrderedPoolResult> => {
  const { read, commit, stop } = opts
  const ready = new Map<number, R>()
  let next = 0
  let committed = 0
  // Gán trong closure (worker / chuỗi ghép) — ép kiểu để TS không thu hẹp thành `null`
  let error = null as { err: unknown } | null
  const fail = (err: unknown): void => {
    stop.aborted = true
    error ??= { err }
  }

  // Một chuỗi ghép duy nhất ⇒ commit không bao giờ chạy chồng nhau và luôn theo thứ tự
  let chain: Promise<void> = Promise.resolve()
  const drain = async (): Promise<void> => {
    while (!error && ready.has(committed)) {
      const i = committed
      const value = ready.get(i)!
      ready.delete(i)
      try {
        await commit(items[i], value, i)
      } catch (err) {
        fail(err)
        return
      }
      committed++
    }
  }

  const worker = async (): Promise<void> => {
    while (!stop.aborted && next < items.length) {
      const i = next++
      let res: PoolRead<R>
      try {
        res = await read(items[i], i)
      } catch (err) {
        fail(err)
        return
      }
      if (!res.ok) {
        stop.aborted = true
        return
      }
      ready.set(i, res.value)
      chain = chain.then(drain)
    }
  }

  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  // Worker cuối có thể vừa nối thêm vào chuỗi — chờ tới khi chuỗi không còn đổi
  for (let seen: Promise<void> | null = null; seen !== chain; ) {
    seen = chain
    await seen
  }
  if (error) throw error.err
  return { committed }
}
