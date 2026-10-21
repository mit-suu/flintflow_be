/**
 * Model hay sửa MỘT dòng của mảng chuỗi bằng chỉ số (`set functions[id=FN004].normal[2] = "…"`) — path chỉ số bị op engine
 * cấm (`index_selector_forbidden`), và một op như vậy làm chết cả bản xem trước gộp của hoà giải (e2e FAP 21/10: bấm
 * "Viết lại" trên 7 mục cũ ⇒ lỗi, không ghi gì). Mảng chuỗi (`normal`, `abnormal`, `tabs`, `flow_to`…) không có khoá để
 * chọn phần tử, nên op đó được viết lại thành `set` CẢ mảng từ giá trị hiện tại, chỉ đổi đúng vị trí model nhắm.
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

export const expandIndexSelectors = (spine: Spine, ops: readonly Op[]): Op[] => {
  const working = new Map<string, unknown[]>()
  return ops.map((op) => {
    if (op.op !== "set" && op.op !== "remove") return op
    const match = TRAILING_INDEX.exec(op.path)
    if (!match || /\[\d+\]/.test(match[1])) return op
    const [, base, raw] = match
    const index = Number(raw)
    let array = working.get(base)
    if (!array) {
      const current = tryResolve(spine, base)?.value
      if (!isPrimitiveArray(current)) return op
      array = [...current]
    }
    if (op.op === "set") {
      if (index > array.length) return op
      array[index] = op.value
    } else {
      if (index >= array.length) return op
      array.splice(index, 1)
    }
    working.set(base, array)
    return { op: "set", path: base, value: [...array], ...(op.reason === undefined ? {} : { reason: op.reason }) }
  })
}
