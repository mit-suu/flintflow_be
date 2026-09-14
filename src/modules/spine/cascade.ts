/**
 * cascade.ts
 * ─────────────────────────────────────────────────────────────────
 * Sinh op cascade khi lô xoá phần tử đang được tham chiếu (srs-spine.md §3).
 *
 * Engine áp op của lô trước, rồi gọi `planCascade` lặp tới điểm bất động:
 * op cascade chỉ nhắm khoá trỏ tới phần tử ĐÃ BỊ XOÁ TRONG LÔ NÀY (`RemovedIds`).
 * Khoá chết do `set` sai hoặc có sẵn từ trước không được "dọn hộ" — bất biến 3 bắt.
 * Lô đã tự liệt kê op cascade (như fixture case-03) thì không sinh trùng.
 *
 * Chính sách theo field (§4.1):
 *   pull          gỡ phần tử khỏi mảng khoá            use_cases[].actor_ids[] …
 *   null          đặt khoá về null                     roles[].actor_id, screens[].primary_function_id
 *   remove_owner  xoá luôn phần tử chứa khoá           permissions, functions[screen_id], diagrams, flags,
 *                                                      assumptions, sections[function:*|feature:*], steps[@X]
 *   restrict      không tự xoá; trả `referrers`,       screens[].feature_id, functions[].feature_id
 *                 bất biến 3 từ chối cả lô
 *   invariant     để yên / bất biến khác quyết         progress.screen_cursor (bất biến 8),
 *                                                      addendum[].target_section (chỉ cần đúng dạng, không chết)
 */

import type { Spine } from "./spine.types.js"
import type { Op, Referrer } from "./op.types.js"
import { isRecord, parsePath } from "./path-resolver.js"
import {
  buildIdIndex,
  iterateReferences,
  referenceAlive,
  type IdCollection,
  type ReferenceHit
} from "./reference-fields.js"
import { SCREEN_LOOP_PHASE } from "./invariants.js"

export type CascadePolicy = "pull" | "null" | "remove_owner" | "restrict" | "invariant"

export const CASCADE_POLICY: Readonly<Record<string, CascadePolicy>> = Object.freeze({
  "use_cases[].actor_ids[]": "pull",
  "use_cases[].function_ids[]": "pull",
  "use_cases[].includes[]": "pull",
  "use_cases[].extends[]": "pull",
  "screens[].feature_id": "restrict",
  "screens[].flow_to[]": "pull",
  "screens[].primary_function_id": "null",
  "permissions[].screen_id": "remove_owner",
  "permissions[].role_id": "remove_owner",
  "roles[].actor_id": "null",
  "functions[].screen_id": "remove_owner",
  "functions[].feature_id": "restrict",
  "functions[].business_rule_ids[]": "pull",
  "entities[].relations[]": "pull",
  "business_rules[].source_validation_ids[]": "pull",
  "messages[].function_ids[]": "pull",
  "diagrams[].owner_id": "remove_owner",
  "addendum[].target_section": "invariant",
  "flags[].section_id": "remove_owner",
  "assumptions[].path": "remove_owner",
  "sections[].id": "remove_owner",
  "progress.screen_cursor": "invariant",
  "progress.screen_queue[]": "pull",
  "steps[].id": "remove_owner"
})

// ─── removed ids ─────────────────────────────────────────────────

/** Id đã bị xoá trong lô, theo tên collection (khoá segment: `actors`, `validations`, `sections`…). */
export class RemovedIds {
  private readonly byCollection = new Map<string, Set<string>>()

  add(collection: string, id: string): void {
    const set = this.byCollection.get(collection) ?? new Set<string>()
    set.add(id)
    this.byCollection.set(collection, set)
  }

  has(collection: string, id: string): boolean {
    return this.byCollection.get(collection)?.has(id) ?? false
  }

  size(collection: string): number {
    return this.byCollection.get(collection)?.size ?? 0
  }

  /** Ghi nhận một phần tử bị xoá khỏi mảng `collection` (kể cả validations lồng trong function). */
  trackElement(collection: string, element: unknown): void {
    if (!isRecord(element) || typeof element.id !== "string") return
    this.add(collection, element.id)
    if (collection === "functions" && Array.isArray(element.validations)) {
      for (const v of element.validations) if (isRecord(v) && typeof v.id === "string") this.add("validations", v.id)
    }
  }
}

/** Khoá chết của `hit` có phải do phần tử bị xoá trong lô không. */
const deadByRemoval = (hit: ReferenceHit, removed: RemovedIds): boolean => {
  switch (hit.target) {
    case "section_key": {
      const id = hit.targetId
      if (removed.has("sections", id)) return true
      if (id.startsWith("feature:")) return removed.has("features", id.slice("feature:".length))
      if (id.startsWith("function:")) return removed.has("functions", id.slice("function:".length))
      return false
    }
    case "path":
      try {
        return parsePath(hit.targetId).some((seg) => {
          const sel = seg.selector
          if (sel?.kind !== "match") return false
          const id = sel.pairs.find(([k]) => k === "id")?.[1]
          return id !== undefined && removed.has(seg.key, id)
        })
      } catch {
        return false
      }
    case "diagram_owner":
      return false
    default:
      return removed.has(hit.target satisfies IdCollection, hit.targetId)
  }
}

// ─── plan ────────────────────────────────────────────────────────

export interface CascadePlan {
  ops: Op[]
  referrers: Referrer[]
}

/**
 * Một vòng cascade trên trạng thái hiện tại. Engine áp `ops` rồi gọi lại tới khi `ops` rỗng.
 * `referrers` là khoá bị `restrict` — lô sẽ bị bất biến 3 từ chối, danh sách này trả cho user.
 */
export const planCascade = (spine: Spine, removed: RemovedIds): CascadePlan => {
  const index = buildIdIndex(spine)
  const ops: Op[] = []
  const referrers: Referrer[] = []
  const seenOwners = new Set<string>()

  for (const hit of iterateReferences(spine)) {
    if (referenceAlive(spine, index, hit) || !deadByRemoval(hit, removed)) continue

    const reason = `Cascade: ${hit.refPath} referenced removed ${hit.targetId}.`
    switch (CASCADE_POLICY[hit.field.path]) {
      case "pull":
        ops.push({ op: "remove", path: hit.refPath, reason })
        break
      case "null":
        ops.push({ op: "set", path: hit.refPath, value: null, reason })
        break
      case "remove_owner":
        if (seenOwners.has(hit.ownerPath)) break
        seenOwners.add(hit.ownerPath)
        ops.push({ op: "remove", path: hit.ownerPath, reason })
        break
      case "restrict":
        referrers.push({ path: hit.refPath, id: hit.targetId })
        break
      case "invariant":
      case undefined:
        break
    }
  }
  return { ops, referrers }
}

/** Xoá feature ⇒ đánh lại `features[].order` liên tục từ 0 (bất biến 5), giữ thứ tự tương đối. */
export const planFeatureRenumber = (spine: Spine, removed: RemovedIds): Op[] => {
  if (removed.size("features") === 0) return []
  return [...spine.features]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.order - b.f.order || a.i - b.i)
    .flatMap(({ f }, order) =>
      f.order === order ? [] : [{ op: "set" as const, path: `features[id=${f.id}].order`, value: order, reason: "Cascade: renumber features after removal." }]
    )
}

/** Bất biến 8: màn thêm khi `current_phase = S-5` phải nằm trong `screen_queue[]`. */
export const planScreenQueueAppend = (after: Spine, before: Spine): Op[] => {
  if (after.progress.current_phase !== SCREEN_LOOP_PHASE) return []
  const existed = new Set(before.screens.map((s) => s.id))
  const queued = new Set(after.progress.screen_queue)
  return after.screens
    .filter((s) => !existed.has(s.id) && !queued.has(s.id))
    .map((s) => ({
      op: "add" as const,
      path: "progress.screen_queue[]",
      value: s.id,
      reason: `Invariant 8: screen ${s.id} added during S-5 appends to the queue.`
    }))
}
