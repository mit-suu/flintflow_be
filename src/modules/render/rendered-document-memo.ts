/**
 * Bản dựng tài liệu nhớ trong tiến trình (FLF-381).
 *
 * Mỗi lượt mở tài liệu trước đây kéo lại cả document cache (~100 KB) từ Atlas (~1,5 s), còn bản xem đã dịch thì dựng
 * lại từ đầu (đọc cả lịch sử `changes`, vài trăm KB). Hai bộ nhớ ở đây giữ bản đã có, khoá theo đúng những thứ làm
 * nội dung đổi — caller ghép khoá:
 * - `documentMemo`: thân document cache, khoá `_id` + `updatedAt` của chính document đó (`cacheMemoKey`) — mọi lần ghi
 *   lại nó (dựng lại, cập nhật ảnh thiếu, xoá rồi tạo lại) đều đổi khoá; lượt đọc chỉ còn hỏi vài chục byte.
 * - `translatedMemo`: bản xem đã dịch, khoá danh tính bản Spine / baseline + ngôn ngữ + revision lớp bản dịch.
 *
 * Giữ dạng tham chiếu ảnh (chưa phân giải) — ảnh vẫn phân giải mỗi lượt vì PNG sơ đồ có thể vẽ lại mà không ghi lại
 * thứ gì trong khoá. Không giữ bytes ảnh. LRU có trần; vào / ra đều `structuredClone` nên caller sửa thoải mái.
 */

const MEMO_MAX = 32

export interface Memo<V> {
  get(key: string): V | null
  set(key: string, value: V): void
  clear(): void
}

const all = new Set<Map<string, unknown>>()

/** Một bộ nhớ LRU có kiểu; mọi bộ tạo ra đều được `clearDocumentMemo` dọn. */
export const createMemo = <V>(max = MEMO_MAX): Memo<V> => {
  const entries = new Map<string, V>()
  all.add(entries)
  return {
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return null
      // LRU: dùng lại thì đưa về cuối
      entries.delete(key)
      entries.set(key, hit)
      return structuredClone(hit)
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, structuredClone(value))
      if (entries.size > max) entries.delete(entries.keys().next().value as string)
    },
    clear: () => entries.clear()
  }
}

/** Khoá của một phiên bản document cache: đổi mỗi lần document đó được ghi. */
export const cacheMemoKey = (row: { _id: unknown; updatedAt?: unknown }): string => {
  const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : String(row.updatedAt ?? "")
  return `${String(row._id)}:${at}`
}

/** Test dùng để cô lập giữa các ca (cùng kiểu `clearReadCache` của Spine). */
export const clearDocumentMemo = (): void => {
  for (const entries of all) entries.clear()
}
