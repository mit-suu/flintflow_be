/**
 * Đổi mẫu ngược: mục nào đã được sửa kể từ lần đổi mẫu gần nhất (`applied_at`) — theo `section_id`, từ log Change của Spine.
 *
 * Mục chưa sửa thì lấy lại nguyên khối + chữ từ snapshot, mục đã sửa BA chọn giữ / hoàn tác. Change do chính lần đổi mẫu ghi
 * (`txn` bắt đầu bằng `TEMPLATE_MIGRATION_TXN_PREFIX`) không tính là "sửa". Change không thuộc section nào (cờ, tiến độ, baseline…)
 * bị bỏ qua; change thuộc phần tử (`function:*`…) tính cho mục khung cha qua `resolveKey`.
 */
import { sectionsOfPath } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Change, Spine } from "../spine/spine.types.js"
import type { Follower, OldHeading } from "./pair-sections.js"

/** Lô op của lần đổi mẫu ghi vào Spine phải có `txn` bắt đầu bằng tiền tố này. */
export const TEMPLATE_MIGRATION_TXN_PREFIX = "template-migration:"

export interface EditedSection {
  /** `old_key` của mục ở tài liệu hiện tại. */
  key: string
  changes: number
  last_at: string
  /** Số ký tự của giá trị mới nhất mỗi path đã sửa — đầu vào ước tính credit dịch. */
  chars: number
}

export interface EditedResult {
  sections: EditedSection[]
  /** Change có section nhưng không gắn được vào mục nào của tài liệu hiện tại. */
  unattributed: number
}

/** `section_id` của Change ⇒ `old_key` (mục có heading, hoặc mục cha của phần tử); `null` nếu không gắn được. */
export type KeyResolver = (sectionId: string) => string | null

export const sectionKeyResolver = (old: readonly OldHeading[], followers: readonly Follower[]): KeyResolver => {
  const keys = new Set(old.map((o) => o.key))
  const parentOf = new Map(followers.map((f) => [f.old_key, f.parent_old_key]))
  return (sectionId) => (keys.has(sectionId) ? sectionId : (parentOf.get(sectionId) ?? null))
}

const charsOf = (value: unknown): number => (typeof value === "string" ? value.length : value === undefined || value === null ? 0 : JSON.stringify(value).length)

export const editedSections = (changes: readonly Change[], spine: Spine, appliedAt: Date, resolveKey: KeyResolver): EditedResult => {
  const since = appliedAt.getTime()
  const bySection = new Map<string, { changes: number; last_at: string; values: Map<string, number> }>()
  let unattributed = 0

  for (const c of changes) {
    if (Date.parse(c.at) <= since || c.txn.startsWith(TEMPLATE_MIGRATION_TXN_PREFIX)) continue
    const owners = sectionsOfPath(spine, c.path, { before: c.before, value: c.value }).owner
    const keys = [...new Set(owners.map(resolveKey).filter((k): k is string => !!k))]
    if (owners.length && !keys.length) unattributed++
    for (const key of keys) {
      const entry = bySection.get(key) ?? { changes: 0, last_at: c.at, values: new Map<string, number>() }
      entry.changes++
      if (c.at > entry.last_at) entry.last_at = c.at
      // Cùng một path sửa nhiều lần chỉ tính giá trị cuối (change sắp theo seq)
      entry.values.set(c.path, charsOf(c.value))
      bySection.set(key, entry)
    }
  }
  return {
    sections: [...bySection].map(([key, e]) => ({ key, changes: e.changes, last_at: e.last_at, chars: [...e.values.values()].reduce((a, b) => a + b, 0) })),
    unattributed
  }
}

/** Đọc Spine + log Change của project rồi tính `editedSections` (log đọc tăng dần, có cache — không quét lại cả lịch sử mỗi lần). */
export const editedSince = async (projectId: string, appliedAt: Date, resolveKey: KeyResolver): Promise<EditedResult> => {
  const [spine, changes] = await Promise.all([spineRepository.get(projectId), spineRepository.listChanges(projectId, {})])
  return spine ? editedSections(changes, spine, appliedAt, resolveKey) : { sections: [], unattributed: 0 }
}
