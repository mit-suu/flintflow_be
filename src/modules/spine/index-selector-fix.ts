/**
 * Model hay sửa MỘT dòng của mảng chuỗi bằng chỉ số (`set functions[id=FN004].normal[2] = "…"`) — path chỉ số bị op engine
 * cấm (`index_selector_forbidden`), và một op như vậy làm chết cả bản xem trước gộp của hoà giải (e2e FAP 21/10: bấm
 * "Viết lại" trên 7 mục cũ ⇒ lỗi, không ghi gì). Mảng chuỗi (`normal`, `abnormal`, `tabs`, `flow_to`…) không có khoá để
 * chọn phần tử, nên op đó được viết lại thành `set` CẢ mảng từ giá trị hiện tại, chỉ đổi đúng vị trí model nhắm.
 *
 * P08 (T6): thêm `add …[n]` (chèn vào vị trí) và `set …[=<giá trị cũ>]` — `project.goals` là mảng chuỗi, model sửa "mục tiêu
 * đầu tiên" bằng một trong ba dạng; trước đây chỉ `set`/`remove [n]` được viết lại, dạng khác chết vì chỉ số.
 *
 * Chỉ áp cho op do MODEL soạn. Không thêm / bớt op (giữ `op_index` của lỗi); nhiều op cùng một mảng cộng dồn theo thứ tự.
 * Path mà phần trước chỉ số không phân giải được, hay mảng chứa object (phải chọn bằng khoá), giữ nguyên để op engine
 * báo lỗi như cũ.
 */

import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { tryResolve } from "./path-resolver.js"

/** Chỉ số ở CUỐI path; phần trước không được còn chỉ số nào khác. */
const TRAILING_INDEX = /^(.+)\[(\d+)\]$/

const isPrimitiveArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")

/** P08 (T6): `set project.goals[=<chữ cũ>]` — op engine không `set` được phần tử vô hướng ⇒ cũng viết lại thành set cả mảng. */
const TRAILING_SCALAR = /^(.+)\[=([^\]]+)\]$/

/**
 * Vị trí op nhắm trong mảng chuỗi `base`: `[n]` (set / remove / add chèn vào vị trí) hoặc `[=<giá trị>]` (chỉ `set`). `null` ⇒
 * op không thuộc dạng cần viết lại.
 */
const targetOf = (op: Op): { base: string; index: number | null; scalar: string | null } | null => {
  const indexed = TRAILING_INDEX.exec(op.path)
  if (indexed && !/\[\d+\]/.test(indexed[1])) return { base: indexed[1], index: Number(indexed[2]), scalar: null }
  const scalar = op.op === "set" ? TRAILING_SCALAR.exec(op.path) : null
  if (scalar && !/\[/.test(scalar[1].slice(scalar[1].lastIndexOf(".") + 1))) return { base: scalar[1], index: null, scalar: scalar[2] }
  return null
}

export const expandIndexSelectors = (spine: Spine, ops: readonly Op[]): Op[] => {
  const working = new Map<string, unknown[]>()
  return ops.map((op) => {
    if (op.op !== "set" && op.op !== "remove" && op.op !== "add") return op
    const target = targetOf(op)
    if (!target) return op
    const { base } = target
    let array = working.get(base)
    if (!array) {
      const current = tryResolve(spine, base)?.value
      if (!isPrimitiveArray(current)) return op
      array = [...current]
    }
    const index = target.index ?? array.findIndex((v) => String(v) === target.scalar)
    if (index < 0) return op
    if (op.op === "set") {
      if (index > array.length) return op
      array[index] = op.value
    } else if (op.op === "add") {
      if (index > array.length || op.value === undefined) return op
      array.splice(index, 0, op.value)
    } else {
      if (index >= array.length) return op
      array.splice(index, 1)
    }
    working.set(base, array)
    return { op: "set", path: base, value: [...array], ...(op.reason === undefined ? {} : { reason: op.reason }) }
  })
}
