/**
 * addendum-stamp.ts
 * ─────────────────────────────────────────────────────────────────
 * `addendum[].captured_at` là lúc server ghi nhận điều user nói — model không biết giờ thật và hay bịa ngày (lấy ngày
 * trong ví dụ của prompt). Mọi lô op do MODEL phát (soạn bước, change request, hoà giải) đi qua đây trước khi ghi:
 * `add addendum[]` ⇒ `captured_at` là giờ server, ghi đè giá trị model. Op thủ công / migration không đi qua đây.
 * Không thêm/bớt/đổi thứ tự op — `op_index` của lỗi validate vẫn trỏ đúng lô model gửi.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export const stampAddendum = <T>(ops: readonly T[], now: Date = new Date()): T[] => {
  const at = now.toISOString()
  return ops.map((op) => {
    if (!isRecord(op) || op.op !== "add" || op.path !== "addendum[]" || !isRecord(op.value)) return op
    return { ...op, value: { ...op.value, captured_at: at } } as T
  })
}
