/**
 * Nhãn version của bản làm việc (FLF-295, BR-03): version chỉ có số major; bản nháp hiện baseline gốc và số thay đổi
 * chưa phát hành — không lộ `spine_version` (bộ đếm transaction nội bộ, một lần sửa có thể tăng 2 vì tính lại cờ).
 *
 * - Chưa có baseline ⇒ `v0`.
 * - Có baseline ⇒ version của baseline cuối, thêm ` + N change(s)` khi có lô sửa nội dung sau lúc ký.
 *   Lô chỉ chạm gốc hệ thống quản lý (cờ, step, tiến độ, sơ đồ…) không tính là thay đổi nội dung.
 */

import type { Change, Spine } from "../spine/spine.types.js"

const SYSTEM_ROOTS: ReadonlySet<string> = new Set(["flags", "steps", "progress", "baselines", "baseline_submission", "sections", "diagrams"])

const rootOf = (path: string): string => path.split(/[.[]/, 1)[0]

/** Số lô (`txn`) sửa nội dung ghi sau thời điểm `since`. */
export const unreleasedChangeCount = (changes: readonly Pick<Change, "txn" | "path" | "at">[], since: string): number => {
  const txns = new Set<string>()
  for (const c of changes) if (c.at > since && !SYSTEM_ROOTS.has(rootOf(c.path))) txns.add(c.txn)
  return txns.size
}

export const draftVersionLabel = (spine: Pick<Spine, "baselines">, changes: readonly Pick<Change, "txn" | "path" | "at">[]): string => {
  const base = spine.baselines[spine.baselines.length - 1]
  if (!base) return "v0"
  const n = unreleasedChangeCount(changes, base.at)
  return n === 0 ? base.version : `${base.version} + ${n} change${n === 1 ? "" : "s"}`
}
