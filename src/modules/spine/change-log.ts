/**
 * Lịch sử `changes` của project đọc tăng dần, nhớ trong tiến trình (FLF-381).
 *
 * Lượt dựng tài liệu cần cả lịch sử (`computeSectionStates`, §I Record of Changes); dự án lớn có vài nghìn change, cả
 * `before`/`value` ⇒ hơn 1 MB, đọc qua Atlas mất 10–15 s — và lượt mở tài liệu đầu tiên sau MỖI lần sửa đều trả giá đó.
 *
 * Đúng vì `changes` chỉ được THÊM, theo `seq` tăng dần (`spine.repository#appendChanges`). Ngoại lệ duy nhất là xoá đuôi
 * `seq ≥ fromSeq` (`restoreSnapshot`, xoá project) — rồi `seq` có thể được dùng lại. Nên mỗi lượt đọc chỉ tải phần
 * `seq > lastSeq`, rồi hỏi lại `_id` của change ở `lastSeq` đã nhớ (vài chục byte): còn đúng `_id` đó ⇒ mọi change
 * `seq ≤ lastSeq` vẫn nguyên (xoá đuôi luôn cuốn theo change lớn nhất); khác / không còn ⇒ đọc lại toàn bộ.
 *
 * Không giữ trong transaction đang mở: đọc ngoài session chỉ thấy bản đã commit. LRU có trần; trả `structuredClone`.
 */

import { Change as ChangeModel } from "./change.model.js"

const LOG_MAX = 32

interface RawChange {
  _id: unknown
  seq: number
}

interface Log<T> {
  rows: T[]
  lastSeq: number
  lastId: string
}

export interface ChangeLog<T> {
  list(projectId: string): Promise<T[]>
}

const allLogs = new Set<Map<string, unknown>>()

/**
 * Một lịch sử đọc tăng dần với `projection` (`null` = đủ field) và `map` từ document thô sang hàng caller cần.
 * `projection` không cần ghi `seq` — luôn được thêm vào (cùng `_id`) để làm mốc.
 */
export const createChangeLog = <T>(projection: Record<string, 1> | null, map: (doc: never) => T): ChangeLog<T> => {
  const logs = new Map<string, Log<T>>()
  allLogs.add(logs)
  const fields = projection ? { ...projection, seq: 1 as const, _id: 1 as const } : null
  const fetch = async (projectId: string, afterSeq: number | null): Promise<RawChange[]> =>
    (await ChangeModel.find(afterSeq === null ? { projectId } : { projectId, seq: { $gt: afterSeq } }, fields, {
      sort: { seq: 1 },
      lean: true
    })) as unknown as RawChange[]

  const remember = (key: string, log: Log<T>): void => {
    logs.delete(key)
    // Mốc phải có `_id` thật (Mongo luôn gán) — không có thì không phân biệt được bản ghi lại cùng `seq`, đừng nhớ
    if (log.lastId === "undefined" || log.lastId === "null") return
    logs.set(key, log)
    if (logs.size > LOG_MAX) logs.delete(logs.keys().next().value as string)
  }

  return {
    async list(projectId) {
      const key = String(projectId)
      const known = logs.get(key)
      if (known) {
        // Tải phần mới TRƯỚC, kiểm mốc SAU: một lượt xoá đuôi chen giữa hai truy vấn luôn làm mốc lệch ⇒ đọc lại toàn bộ,
        // không bao giờ ghép đầu lịch sử cũ với đuôi lịch sử mới
        const fresh = await fetch(projectId, known.lastSeq)
        const anchor = (await ChangeModel.findOne({ projectId, seq: known.lastSeq }, { _id: 1 }, { lean: true })) as { _id: unknown } | null
        if (anchor && String(anchor._id) === known.lastId) {
          const last = fresh[fresh.length - 1]
          const log = last ? { rows: [...known.rows, ...fresh.map((doc) => map(doc as never))], lastSeq: last.seq, lastId: String(last._id) } : known
          remember(key, log)
          return structuredClone(log.rows)
        }
      }
      const docs = await fetch(projectId, null)
      const rows = docs.map((doc) => map(doc as never))
      const last = docs[docs.length - 1]
      if (last) remember(key, { rows, lastSeq: last.seq, lastId: String(last._id) })
      else logs.delete(key)
      return structuredClone(rows)
    }
  }
}

/** Test dùng để cô lập giữa các ca (cùng kiểu `clearReadCache`). */
export const clearChangeLogs = (): void => {
  for (const logs of allLogs) logs.clear()
}
