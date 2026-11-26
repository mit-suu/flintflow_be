/**
 * screen-platforms.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-493: nền tảng mockup của một màn do code xác định, không để model tự quyết lúc có lúc không. Mỗi actor người có
 * `platforms`; nền tảng của màn = hợp nền tảng các actor dùng màn (`screenActorSets`) giao với nền tảng theme dự án.
 * Model chỉ được thu hẹp thêm trong tập này (`platformsToDraw`). Hàm thuần.
 *
 * Nền tảng hiệu lực của actor: có `platforms` khác rỗng thì dùng; không mà là actor cha thì hợp của các con; còn lại
 * "chưa biết". Màn không có actor, hoặc có actor chưa biết ⇒ trả nguyên theme (hành vi cũ — spine cũ, dự án import).
 */

import { SCREEN_PLATFORMS, type ResolvedScreenTheme, type ScreenPlatform } from "../../shared/diagram/screen-theme.js"
import type { Spine } from "./spine.types.js"
import { screenActorSets } from "./screen-actors.js"

type PlatformSource = Parameters<typeof screenActorSets>[0]

/** `actor_id → nền tảng hiệu lực` (không có mục ⇒ chưa biết). */
const effectivePlatforms = (actors: Spine["actors"]): Map<string, ScreenPlatform[]> => {
  const children = new Map<string, string[]>()
  for (const a of actors) if (a.kind === "human" && a.parent_id) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a.id])
  const byId = new Map(actors.map((a) => [a.id, a]))
  const out = new Map<string, ScreenPlatform[]>()
  const resolve = (id: string, seen: ReadonlySet<string>): ScreenPlatform[] | null => {
    const own = byId.get(id)?.platforms?.filter((p) => SCREEN_PLATFORMS.includes(p)) ?? []
    if (own.length > 0) return SCREEN_PLATFORMS.filter((p) => own.includes(p))
    if (seen.has(id)) return null
    const kids = children.get(id) ?? []
    if (kids.length === 0) return null
    const parts = kids.map((k) => resolve(k, new Set([...seen, id])))
    // Một con chưa biết thì cha cũng chưa biết
    if (parts.some((p) => p === null)) return null
    const union = new Set(parts.flatMap((p) => p ?? []))
    return SCREEN_PLATFORMS.filter((p) => union.has(p))
  }
  for (const a of actors) {
    if (a.kind !== "human") continue
    const found = resolve(a.id, new Set())
    if (found) out.set(a.id, found)
  }
  return out
}

export const screenPlatforms = (spine: PlatformSource, screenId: string, themePlatforms: readonly ScreenPlatform[]): ScreenPlatform[] => {
  const actors = screenActorSets(spine).get(screenId) ?? []
  if (actors.length === 0) return [...themePlatforms]
  const known = effectivePlatforms(spine.actors)
  const sets = actors.map((id) => known.get(id))
  if (sets.some((s) => s === undefined)) return [...themePlatforms]
  const union = new Set(sets.flatMap((s) => s ?? []))
  const result = SCREEN_PLATFORMS.filter((p) => union.has(p) && themePlatforms.includes(p))
  return result.length > 0 ? result : [...themePlatforms]
}

/** Theme của riêng màn: như theme dự án nhưng `platforms` thu theo actor dùng màn. */
export const screenThemeFor = (spine: PlatformSource, screenId: string, theme: ResolvedScreenTheme): ResolvedScreenTheme => ({
  ...theme,
  platforms: screenPlatforms(spine, screenId, theme.platforms)
})
