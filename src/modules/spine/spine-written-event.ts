/**
 * Sự kiện `spine_written` sau mỗi lô ghi Spine thành công (FLF-487) — cho tab khác đang mở dự án tải bản mới ngay và
 * báo "<người> vừa ghi … vào mục …".
 *
 * Ánh xạ `by` / `step_id` / `op` của change (một lô cùng `by`) ⇒ nguồn:
 *
 * | Change                                   | `source` | Người                              |
 * | `by` = `CR-<số>`                          | `cr`     | người tạo CR (`created_by`)         |
 * | `by` = user id, có `op: "revert"`         | `undo`   | user đó                            |
 * | `by` = user id, có `step_id`              | `step`   | user đó (bấm chạy / chốt bước)      |
 * | `by` = user id, còn lại                   | `edit`   | user đó (sửa qua chat, sơ đồ, mẫu…) |
 * | còn lại (`import`, `template-migration`…) | `system` | không có                           |
 *
 * Lô không chạm section nào (con trỏ step, ledger, cờ, giả định…) ⇒ không phát: tài liệu không đổi.
 * Cùng dự án + cùng `by` trong `DEBOUNCE_MS` ⇒ gộp một sự kiện (một lượt chạy step ghi nhiều lô liền nhau).
 * Mọi lỗi chỉ log — không bao giờ làm hỏng lệnh ghi đã thành công.
 */

import mongoose from "mongoose"
import type { Change, Spine } from "./spine.types.js"
import { sectionsOfPath } from "./section-registry.js"
import { projectKey, publishRealtime, type SpineWriteSource, type SpineWrittenEvent } from "../../shared/realtime/project-events.js"

export const MAX_EVENT_SECTIONS = 8
export const DEBOUNCE_MS = 1500

const CR_ID = /^CR-\d+$/

export interface WriteActor {
  source: SpineWriteSource
  cr_id: string | null
  /** User id cần tra tên (CR ⇒ chưa biết, tra `created_by` sau). */
  user_id: string | null
}

/** Nguồn + người theo bảng đầu file — hàm thuần. */
export const actorOfChanges = (changes: Pick<Change, "by" | "op" | "step_id">[]): WriteActor => {
  const by = changes[0]?.by ?? ""
  if (CR_ID.test(by)) return { source: "cr", cr_id: by, user_id: null }
  if (!mongoose.isValidObjectId(by)) return { source: "system", cr_id: null, user_id: null }
  const source: SpineWriteSource = changes.some((c) => c.op === "revert") ? "undo" : changes.some((c) => c.step_id) ? "step" : "edit"
  return { source, cr_id: null, user_id: by }
}

/** Section (owner) bị ghi, theo thứ tự xuất hiện, không trùng — hàm thuần. */
export const sectionsOfChanges = (spine: Spine, changes: Pick<Change, "path" | "before" | "value">[]): string[] => {
  const out = new Set<string>()
  for (const c of changes) {
    for (const id of sectionsOfPath(spine, c.path, { before: c.before, value: c.value }).owner) out.add(id)
  }
  return [...out]
}

// ─── tra cứu DB (đọc thẳng collection: tránh vòng import spine ⇄ change-request) ───

const db = () => mongoose.connection.db

const userNameOf = async (id: string): Promise<string | null> => {
  const user = (await db()?.collection("users").findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { name: 1, email: 1 } })) as
    | { name?: string; email?: string }
    | null
    | undefined
  return user?.name || user?.email || null
}

const crCreatorOf = async (projectId: string, crId: string): Promise<string | null> => {
  const cr = (await db()?.collection("changerequests").findOne(
    { projectId: new mongoose.Types.ObjectId(projectId), cr_id: crId },
    { projection: { created_by: 1 } }
  )) as { created_by?: mongoose.Types.ObjectId } | null | undefined
  return cr?.created_by ? String(cr.created_by) : null
}

export interface EventLookups {
  userName: (id: string) => Promise<string | null>
  crCreator: (projectId: string, crId: string) => Promise<string | null>
}

const defaultLookups: EventLookups = { userName: userNameOf, crCreator: crCreatorOf }

// ─── gộp + phát ──────────────────────────────────────────────────

interface Pending {
  actor: WriteActor
  sections: string[]
  spine_version: number
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

const flush = async (projectId: string, entry: Pending, lookups: EventLookups): Promise<void> => {
  const userId = entry.actor.cr_id ? await lookups.crCreator(projectId, entry.actor.cr_id) : entry.actor.user_id
  const event: SpineWrittenEvent = {
    type: "spine_written",
    project_id: projectId,
    spine_version: entry.spine_version,
    actor_user_id: userId,
    actor_name: userId ? await lookups.userName(userId) : null,
    source: entry.actor.source,
    cr_id: entry.actor.cr_id,
    sections: entry.sections.slice(0, MAX_EVENT_SECTIONS),
    more: Math.max(0, entry.sections.length - MAX_EVENT_SECTIONS),
    at: new Date().toISOString()
  }
  publishRealtime(projectKey(projectId), event)
}

/**
 * Gọi ngay sau `applyAndSave` thành công, KHÔNG await. Gộp các lô liền nhau của cùng người rồi phát một sự kiện.
 */
export const notifySpineWritten = (
  projectId: string,
  spine: Spine & { spine_version: number },
  changes: Change[],
  lookups: EventLookups = defaultLookups
): void => {
  try {
    if (!changes.length) return
    const sections = sectionsOfChanges(spine, changes)
    if (!sections.length) return
    const actor = actorOfChanges(changes)
    const key = `${projectId}|${changes[0].by}`
    const prev = pending.get(key)
    if (prev) clearTimeout(prev.timer)
    const entry: Pending = {
      actor,
      sections: prev ? [...new Set([...prev.sections, ...sections])] : sections,
      spine_version: spine.spine_version,
      timer: setTimeout(() => {
        pending.delete(key)
        flush(projectId, entry, lookups).catch((err: unknown) => console.error("[project-events] dựng sự kiện lỗi", err instanceof Error ? err.message : err))
      }, DEBOUNCE_MS)
    }
    // Không giữ process sống chỉ vì một thông báo chưa phát (test, tắt server)
    entry.timer.unref?.()
    pending.set(key, entry)
  } catch (err) {
    console.error("[project-events] bỏ sự kiện ghi", err instanceof Error ? err.message : err)
  }
}
