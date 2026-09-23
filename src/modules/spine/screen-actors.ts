/**
 * screen-actors.ts
 * ─────────────────────────────────────────────────────────────────
 * Màn nào do actor người (`actors[kind=human]`) nào dùng trực tiếp — nguồn tách sơ đồ Screens Flow theo actor
 * (§3.1.1), `source_hash` của nó và cờ `orphan_screen`. Spine không có field actor trên màn, nên suy ra từ hai
 * đường đã có:
 *   1. `permissions[].screen_id` → `roles[].actor_id` (S-4.3 — ai được vào màn),
 *   2. `use_cases[].actor_ids` × `function_ids` → `functions[].screen_id` (use case của actor chạy trên màn).
 * Actor `system`/`time` không thao tác UI nên bị bỏ. Hàm thuần, kết quả sắp theo id.
 */

import type { Spine } from "./spine.types.js"

type ScreenActorSource = Pick<Spine, "actors" | "roles" | "permissions" | "use_cases" | "functions" | "screens">

/** `screen_id → actor_id[]` (chỉ actor người, sắp theo id). Màn không có actor nào ⇒ mảng rỗng. */
export const screenActorMap = (spine: ScreenActorSource): Map<string, string[]> => {
  const human = new Set(spine.actors.filter((a) => a.kind === "human").map((a) => a.id))
  const screenIds = new Set(spine.screens.map((s) => s.id))
  const links = new Map<string, Set<string>>(spine.screens.map((s) => [s.id, new Set<string>()]))
  const link = (screenId: string | null, actorId: string | null) => {
    if (screenId && actorId && screenIds.has(screenId) && human.has(actorId)) links.get(screenId)?.add(actorId)
  }

  const roleActor = new Map(spine.roles.map((r) => [r.id, r.actor_id]))
  for (const p of spine.permissions) link(p.screen_id, roleActor.get(p.role_id) ?? null)

  const fnScreen = new Map(spine.functions.map((f) => [f.id, f.screen_id]))
  for (const uc of spine.use_cases) {
    for (const fnId of uc.function_ids) for (const actorId of uc.actor_ids) link(fnScreen.get(fnId) ?? null, actorId)
  }

  const sorted = (ids: Set<string>) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return new Map([...links].map(([screenId, ids]) => [screenId, sorted(ids)]))
}

/** Đã có ít nhất một liên kết màn ↔ actor người chưa — trước S-4.3/S-4.4 thường chưa, khi đó chưa tách được. */
export const hasScreenActorLinks = (map: ReadonlyMap<string, readonly string[]>): boolean =>
  [...map.values()].some((ids) => ids.length > 0)
