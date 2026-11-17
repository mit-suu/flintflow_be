/**
 * erd-retry.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-433 (câu 7 `spec/e2e-bugs-2026-11-16/03-can-chot.md`): ERD (S-4.5) trượt luật hình dạng cả 3 lần thử ("AI trả kết quả không
 * hợp lệ sau 3 lần thử") dù lượt thử lại đã gửi vi phạm cụ thể. Ba lớp, chỉ cho lỗi luật ERD (`erd_*`):
 *   1. Tên entity có đuôi màn hình / kỹ thuật ("Exam List") ⇒ code tự bỏ đuôi trước khi kiểm — không tốn một lượt thử.
 *   2. Chế độ bản vá: lô trước chỉ vướng luật ERD ⇒ lô đó được GIỮ, model chỉ trả op sửa; code ghép (lô trước + bản vá) rồi
 *      mới kiểm. Đầu ra nhỏ và tập trung — trước đây model soạn lại cả ERD và vấp chỗ khác.
 *   3. Lần thử cuối mà vẫn chỉ vướng luật ERD ⇒ gọi model mạnh hơn (`ESCALATION_MODEL`), chỉ đúng lượt đó.
 * Hàm thuần.
 */

import type { ValidationError } from "./op-validator.js"

/** Model của lượt thử cuối khi lô vẫn chỉ vướng luật ERD (provider Anthropic của skill `draft-to-ops`). */
export const ESCALATION_MODEL = "claude-sonnet-5-5"

/** Lỗi của lượt trước đều là luật hình dạng ERD (không có lỗi schema / tham chiếu / phạm vi). */
export const isErdOnly = (errors: readonly ValidationError[]): boolean => errors.length > 0 && errors.every((e) => e.rule.startsWith("erd_"))

/** Cùng tập đuôi với luật `erd_entity_name_invalid` (`op-validator.ts`). */
const NAME_SUFFIX = /\s+(list|screen|page|form|popup|modal|dialog|service|manager|controller|dto|table)$/i

/** "Exam List" ⇒ "Exam"; tên chỉ còn đuôi (vd "List") hoặc không có đuôi ⇒ giữ nguyên. */
export const stripEntityNameSuffix = (name: string): string => {
  const trimmed = name.trim()
  const stripped = trimmed.replace(NAME_SUFFIX, "").trim()
  return stripped.length > 0 && stripped !== trimmed ? stripped : name
}

type OpLike = { op?: unknown; path?: unknown; value?: unknown }

/**
 * Bỏ đuôi tên entity trong lô: `add entities[]` (value.name) và `set entities[id=…].name`. Không đổi tên nếu bỏ đuôi làm trùng
 * tên entity khác trong cùng lô (để luật trùng tên báo như cũ).
 */
export const normalizeEntityNames = (ops: readonly unknown[]): unknown[] => {
  const names = new Set<string>()
  for (const raw of ops) {
    const op = raw as OpLike
    if (op?.op === "add" && op.path === "entities[]" && typeof (op.value as { name?: unknown })?.name === "string") names.add(((op.value as { name: string }).name).toLowerCase())
  }
  return ops.map((raw) => {
    const op = raw as OpLike
    if (op?.op === "add" && op.path === "entities[]" && op.value && typeof (op.value as { name?: unknown }).name === "string") {
      const value = op.value as { name: string }
      const next = stripEntityNameSuffix(value.name)
      if (next === value.name || names.has(next.toLowerCase())) return raw
      return { ...op, value: { ...value, name: next } }
    }
    if (op?.op === "set" && typeof op.path === "string" && /^entities\[id=[^\]]+\]\.name$/.test(op.path) && typeof op.value === "string") {
      const next = stripEntityNameSuffix(op.value)
      return next === op.value || names.has(next.toLowerCase()) ? raw : { ...op, value: next }
    }
    return raw
  })
}
