/**
 * screen-actors.ts
 * ─────────────────────────────────────────────────────────────────
 * Màn nào do actor người (`actors[kind=human]`) nào dùng — cho sơ đồ Screens Flow (§3.1.1: màn nào vẽ, màn nào tô nền
 * "dùng chung"), `source_hash` của nó và cờ `orphan_screen`. Actor đúng như mô hình actor – use case: actor tổng quát
 * (`parent_id`) giữ nguyên, không bung xuống actor lá.
 *
 * Nguồn, theo thứ tự ưu tiên (nguồn sau chỉ dùng khi nguồn trước không ra actor người nào):
 *   1. màn → `primary_function_id` → function → use case chứa function đó → `actor_ids`,
 *   2. màn → mọi function có `screen_id` = màn (khi chưa có primary function, hoặc primary không thuộc use case nào),
 *   3. `permissions[].screen_id` → `roles[].actor_id` (S-4.3 — ai được vào màn).
 * Actor `system`/`time` không thao tác UI nên bị bỏ. Hàm thuần.
 */

import type { Spine } from "./spine.types.js"
import { actorParents, ancestorsOf } from "./actor-generalization.js"

type ScreenActorSource = Pick<Spine, "actors" | "roles" | "permissions" | "use_cases" | "functions" | "screens">

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `screen_id → mọi actor người dùng màn` theo thứ tự xuất hiện (rỗng khi không có ai). */
export const screenActorSets = (spine: ScreenActorSource): Map<string, string[]> => {
  const human = new Set(spine.actors.filter((a) => a.kind === "human").map((a) => a.id))
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
      return [screen.id, actors] as const
    })
  )
}

/**
 * `screen_id → [actor đại diện]` (rỗng khi không có actor nào): tổ tiên chung gần nhất của các actor dùng màn, không có
 * tổ tiên chung ⇒ actor đầu tiên. Thuộc `sourceProjection` của `screen_flow` — giữ ổn định để hash ảnh gốc không đổi.
 */
export const screenActorMap = (spine: ScreenActorSource): Map<string, string[]> => {
  const parents = actorParents(spine.actors)
  return new Map(
    [...screenActorSets(spine)].map(([screenId, actors]) => {
      if (actors.length === 0) return [screenId, []]
      const chains = actors.map((id) => [id, ...ancestorsOf(id, parents)])
      const common = chains[0].find((candidate) => chains.every((chain) => chain.includes(candidate)))
      return [screenId, [common ?? actors[0]]]
    })
  )
}

/** Đã có ít nhất một liên kết màn ↔ actor người chưa — trước S-4.1/S-4.4 thường chưa. */
export const hasScreenActorLinks = (map: ReadonlyMap<string, readonly string[]>): boolean =>
  [...map.values()].some((ids) => ids.length > 0)

/**
 * Màn dùng chung (nền `#7ACFF5` trên Screens Flow — ô vàng của hình mẫu template FPT): mọi actor người lá (không có
 * actor người con) đều dùng được màn — chính nó hoặc một tổ tiên của nó nằm trong tập actor của màn. Chưa có actor
 * người nào thì không màn nào dùng chung.
 */
export const sharedScreenIds = (spine: ScreenActorSource): Set<string> => {
  const humans = spine.actors.filter((a) => a.kind === "human")
  const parents = actorParents(spine.actors)
  const hasHumanChild = new Set(humans.map((a) => parents.get(a.id)).filter((p): p is string => p !== undefined))
  const leaves = humans.filter((a) => !hasHumanChild.has(a.id)).map((a) => a.id)
  if (leaves.length === 0) return new Set()
  const shared = new Set<string>()
  for (const [screenId, actors] of screenActorSets(spine)) {
    const users = new Set(actors)
    if (leaves.every((leaf) => [leaf, ...ancestorsOf(leaf, parents)].some((id) => users.has(id)))) shared.add(screenId)
  }
  return shared
}
