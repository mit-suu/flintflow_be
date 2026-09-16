/**
 * undo.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Undo op cuối (UC 6.9, srs-spine.md §9): revert **cả lô `txn` gần nhất do người dùng gây ra** bằng
 * `changes[].before`, qua `revertRange` của op engine (T08) — một txn mới, `op: "revert"`, có `before`
 * của chính nó nên undo cũng nằm trong lịch sử và §I Record of Changes.
 *
 * Thay hoàn toàn rollback kiểu cũ (C2 trong audit: cắt transcript + xoá version, phá huỷ, không khôi
 * phục được). Ở đây không có gì bị xoá: undo chỉ ghi thêm change.
 *
 * Không undo:
 * - Lô do render sinh (`diagrams[]`) hoặc baseline (`baselines[]`) — hình vẽ lại bằng render, baseline
 *   là mốc đã chốt (Phases §6.5).
 * - Lô đã bị undo rồi, và chính lô undo đó — nếu không, undo hai lần liên tiếp sẽ "undo cái undo".
 *
 * `revertRange` vẫn kiểm từng change: giá trị hiện tại phải đúng là giá trị lô đó đã ghi, khác thì
 * `revert_conflict` (422 OP_INVALID) — không ghi đè im lặng thay đổi đến sau.
 */

import { revertRange } from "./op-engine.js"
import * as repository from "./spine.repository.js"
import type { ApplyResult } from "./op.types.js"
import type { Change } from "./spine.types.js"
import { parsePath, PathError } from "./path-resolver.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const NOTHING_TO_UNDO = "NOTHING_TO_UNDO"

/**
 * Gốc path do hệ thống ghi. Lô chỉ chạm các gốc này là việc của máy (render, recompute cờ, chốt
 * baseline, đánh dấu step), không phải "thao tác của người dùng" để undo.
 */
const SYSTEM_ONLY_ROOTS: ReadonlySet<string> = new Set(["diagrams", "baselines", "flags", "sections", "steps", "progress"])

/** `Revert seq 42` — reason mà `op-engine.invertChange` ghi cho mỗi change nghịch đảo. */
const REVERT_REASON_RE = /^Revert seq (\d+)$/

const rootOf = (path: string): string | null => {
  try {
    return parsePath(path)[0].key
  } catch (err) {
    if (err instanceof PathError) return null
    throw err
  }
}

export interface UndoTarget {
  txn: string
  first_seq: number
  last_seq: number
}

interface TxnGroup extends UndoTarget {
  changes: Change[]
}

/** Gom `changes[]` theo `txn`, giữ thứ tự seq. */
const groupByTxn = (changes: readonly Change[]): TxnGroup[] => {
  const groups = new Map<string, TxnGroup>()
  for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
    const group = groups.get(change.txn)
    if (group) {
      group.last_seq = Math.max(group.last_seq, change.seq)
      group.first_seq = Math.min(group.first_seq, change.seq)
      group.changes.push(change)
    } else {
      groups.set(change.txn, { txn: change.txn, first_seq: change.seq, last_seq: change.seq, changes: [change] })
    }
  }
  return [...groups.values()].sort((a, b) => a.first_seq - b.first_seq)
}

const isRevertGroup = (group: TxnGroup): boolean => group.changes.every((c) => c.op === "revert")

const touchesUserData = (group: TxnGroup): boolean =>
  group.changes.some((c) => {
    const root = rootOf(c.path)
    return root !== null && !SYSTEM_ONLY_ROOTS.has(root)
  })

/**
 * Lô sẽ bị undo: lô người dùng gần nhất chưa bị undo. Hàm thuần để test được không cần DB.
 * Trả `null` khi không còn gì (422 `NOTHING_TO_UNDO`).
 */
export const findUndoTarget = (changes: readonly Change[]): UndoTarget | null => {
  const groups = groupByTxn(changes)
  const seqToTxn = new Map(changes.map((c) => [c.seq, c.txn]))
  const consumed = new Set<string>()

  for (const group of groups) {
    if (!isRevertGroup(group)) continue
    consumed.add(group.txn)
    for (const change of group.changes) {
      const seq = REVERT_REASON_RE.exec(change.reason ?? "")?.[1]
      const source = seq === undefined ? undefined : seqToTxn.get(Number(seq))
      if (source !== undefined) consumed.add(source)
    }
  }

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    if (consumed.has(group.txn) || !touchesUserData(group)) continue
    return { txn: group.txn, first_seq: group.first_seq, last_seq: group.last_seq }
  }
  return null
}

export interface UndoOptions {
  /** Khoá lạc quan: `spine_version` client đang xem. */
  base_version: number
}

/** Undo lô gần nhất của project. Ném 422 `NOTHING_TO_UNDO` nếu không còn lô nào undo được. */
export const undoLast = async (projectId: string, userId: string, options: UndoOptions): Promise<ApplyResult> => {
  const changes = await repository.listChanges(projectId)
  const target = findUndoTarget(changes)
  if (!target) throw new ApiError(422, "Không còn thao tác nào để hoàn tác", NOTHING_TO_UNDO)

  return await revertRange(projectId, target.first_seq, target.last_seq, {
    by: userId,
    base_version: options.base_version,
    step_id: null
  })
}
