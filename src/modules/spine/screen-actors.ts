/**
 * screen-actors.ts
 * ─────────────────────────────────────────────────────────────────
 * Màn nào do actor người (`actors[kind=human]`) nào thực hiện — làn (swimlane) của sơ đồ Screens Flow (§3.1.1),
 * `source_hash` của nó, cờ `orphan_screen` và cờ `screen_actor_ambiguous`. Actor đúng như mô hình actor – use case:
 * actor tổng quát (`parent_id`) giữ nguyên, không bung xuống actor lá, không có luật "màn public thuộc mọi actor".
 *
 * Nguồn, theo thứ tự ưu tiên (nguồn sau chỉ dùng khi nguồn trước không ra actor người nào):
 *   1. màn → `primary_function_id` → function → use case chứa function đó → `actor_ids`,
 *   2. màn → mọi function có `screen_id` = màn (khi chưa có primary function, hoặc primary không thuộc use case nào),
 *   3. `permissions[].screen_id` → `roles[].actor_id` (S-4.3 — ai được vào màn).
 * Nhiều actor cùng cha (tổ tiên chung gần nhất) ⇒ làn của actor cha. Nhiều actor không có tổ tiên chung ⇒ mơ hồ: chọn
 * tất định actor đầu tiên theo thứ tự xuất hiện và báo ở `ambiguous` để cờ yêu cầu xem lại mô hình actor.
 * Actor `system`/`time` không thao tác UI nên bị bỏ. Hàm thuần.
 */

import type { Spine } from "./spine.types.js"
import { actorParents, ancestorsOf } from "./actor-generalization.js"

type ScreenActorSource = Pick<Spine, "actors" | "roles" | "permissions" | "use_cases" | "functions" | "screens">

export interface ScreenLane {
  /** Actor người sở hữu làn của màn (có thể là actor tổng quát). */
  actorId: string
  /** Mọi actor ứng viên không có tổ tiên chung (gồm cả `actorId`); rỗng ⇒ không mơ hồ. */
  ambiguous: readonly string[]
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Làn của một tập actor theo thứ tự xuất hiện: tổ tiên chung gần nhất, không có ⇒ actor đầu tiên + mơ hồ. */
const resolveLane = (actors: readonly string[], parents: ReadonlyMap<string, string>): ScreenLane | null => {
  if (actors.length === 0) return null
  const chains = actors.map((id) => [id, ...ancestorsOf(id, parents)])
  const common = chains[0].find((candidate) => chains.every((chain) => chain.includes(candidate)))
  if (common !== undefined) return { actorId: common, ambiguous: [] }
  return { actorId: actors[0], ambiguous: actors }
}

/** `screen_id → làn`. Màn không có actor người nào ⇒ `null`. */
export const screenLanes = (spine: ScreenActorSource): Map<string, ScreenLane | null> => {
  const human = new Set(spine.actors.filter((a) => a.kind === "human").map((a) => a.id))
  const parents = actorParents(spine.actors)
  const useCases = [...spine.use_cases].sort((a, b) => compare(a.id, b.id))
  const functions = [...spine.functions].sort((a, b) => compare(a.id, b.id))
  const roleActor = new Map(spine.roles.map((r) => [r.id, r.actor_id]))

  const unique = (ids: Iterable<string | null | undefined>): string[] => {
    const out: string[] = []
    for (const id of ids) if (id && human.has(id) && !out.includes(id)) out.push(id)
    return out
  }
  const viaUseCases = (functionIds: ReadonlySet<string>): string[] =>
    unique(useCases.filter((u) => u.function_ids.some((f) => functionIds.has(f))).flatMap((u) => u.actor_ids))

  return new Map(
    spine.screens.map((screen) => {
      const primary = functions.find((f) => f.id === screen.primary_function_id)
      let actors = primary ? viaUseCases(new Set([primary.id])) : []
      if (actors.length === 0) actors = viaUseCases(new Set(functions.filter((f) => f.screen_id === screen.id).map((f) => f.id)))
      if (actors.length === 0) {
        actors = unique(
          spine.permissions
            .filter((p) => p.screen_id === screen.id)
            .map((p) => roleActor.get(p.role_id))
            .sort((a, b) => compare(a ?? "", b ?? ""))
        )
      }
      return [screen.id, resolveLane(actors, parents)] as const
    })
  )
}

/** `screen_id → [actor của làn]` (rỗng khi không có actor nào). */
export const screenActorMap = (spine: ScreenActorSource): Map<string, string[]> =>
  new Map([...screenLanes(spine)].map(([screenId, lane]) => [screenId, lane ? [lane.actorId] : []]))

/** Đã có ít nhất một liên kết màn ↔ actor người chưa — trước S-4.1/S-4.4 thường chưa, khi đó chưa chia làn được. */
export const hasScreenActorLinks = (map: ReadonlyMap<string, readonly string[]>): boolean =>
  [...map.values()].some((ids) => ids.length > 0)
