/**
 * Nhãn version của bản làm việc (FLF-295, BR-03): version chỉ có số major; bản nháp hiện baseline gốc và số thay đổi
 * chưa phát hành — không lộ `spine_version` (bộ đếm transaction nội bộ, một lần sửa có thể tăng 2 vì tính lại cờ).
 *
 * - Chưa có baseline ⇒ `v0`.
 * - Có baseline ⇒ version của baseline cuối, thêm ` + N change(s)` khi có lô sửa nội dung sau lúc ký.
 *   Lô chỉ chạm gốc hệ thống quản lý (cờ, step, tiến độ, sơ đồ…) không tính là thay đổi nội dung.
 * - Đổi mẫu (BF L113 "thay đổi hệ thống" cũng vào bản nháp): đã áp dụng, chưa hoàn tác ⇒ +1 change; áp dụng rồi hoàn tác
 *   (`…:<id>:undo` sau mốc) ⇒ triệt tiêu, mọi lô của lần đổi mẫu đó (áp dụng / `:revert` / `:undo`) không tính (Lỗi #4).
 */

import { isAnyMigrationTxn, migrationTxn } from "../template-migration/apply-plan.js"
import type { Change, Spine } from "../spine/spine.types.js"

const SYSTEM_ROOTS: ReadonlySet<string> = new Set(["flags", "steps", "progress", "baselines", "baseline_submission", "sections", "diagrams"])

const rootOf = (path: string): string => path.split(/[.[]/, 1)[0]

/** Số lô (`txn`) sửa nội dung ghi sau thời điểm `since`. */
/** Id lần đổi mẫu của txn `template-migration:<id>[:revert|:undo]`. */
const migrationIdOf = (txn: string): string => txn.slice(migrationTxn("").length).split(":", 1)[0]

export const unreleasedChangeCount = (changes: readonly Pick<Change, "txn" | "path" | "at">[], since: string): number => {
  const after = changes.filter((c) => c.at > since)
  const lots = new Set(after.filter((c) => isAnyMigrationTxn(c.txn)).map((c) => c.txn))
  // Chỉ triệt tiêu khi cả lô áp dụng cũng sau mốc — áp dụng trước khi ký rồi mới hoàn tác thì hoàn tác là một thay đổi
  const undone = new Set([...lots].map(migrationIdOf).filter((id) => lots.has(migrationTxn(id, "undo")) && lots.has(migrationTxn(id))))
  const txns = new Set<string>()
  for (const c of after) {
    if (SYSTEM_ROOTS.has(rootOf(c.path))) continue
    if (isAnyMigrationTxn(c.txn)) {
      const id = migrationIdOf(c.txn)
      if (undone.has(id)) continue
      // Lô áp dụng + lô `:revert` của cùng lần đổi mẫu là một thay đổi
      txns.add(migrationTxn(id))
    } else txns.add(c.txn)
  }
  return txns.size
}

export const draftVersionLabel = (spine: Pick<Spine, "baselines">, changes: readonly Pick<Change, "txn" | "path" | "at">[]): string => {
  const base = spine.baselines[spine.baselines.length - 1]
  if (!base) return "v0"
  const n = unreleasedChangeCount(changes, base.at)
  return n === 0 ? base.version : `${base.version} + ${n} change${n === 1 ? "" : "s"}`
}
