/**
 * §3.x.y Screen Layout (salt) — source_fields: `screens[<owner>].name` ·
 * `functions[screen_id=<owner>].name/.description` (srs-spine §7.1).
 * Low-fi có chủ ý (Phases §7.2): màn có gì và làm gì, không phải trông ra sao.
 * Gắn vào `function:<primary_function_id>`; màn không có primary function ⇒ không render.
 */

import type { Renderer } from "./common.js"
import { compareIds, puml } from "./common.js"

/** Ô salt: bỏ ký tự điều khiển cú pháp salt (`| { } # [ ] < > "`). */
export const saltCell = (text: string): string => text.replace(/[|{}#[\]<>"^()]/g, " ").replace(/\s+/g, " ").trim()

export const MAX_DESCRIPTION_CHARS = 100

const clip = (text: string): string =>
  text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 3).trimEnd()}...` : text

export const renderScreenLayout: Renderer = (spine, ownerId) => {
  const screen = spine.screens.find((s) => s.id === ownerId)
  if (!screen || screen.primary_function_id === null) return []

  const functions = spine.functions
    .filter((f) => f.screen_id === screen.id)
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
  const rows = functions.length > 0 ? functions.map((f) => `    ${saltCell(f.name) || f.id} | ${clip(saltCell(f.description)) || "-"}`) : ["    - | No functions yet"]

  const body = ["{+", `  <b>${saltCell(screen.name) || screen.id}`, "  {#", "    <b>Function | <b>Description", ...rows, "  }", "}"]

  return [
    {
      kind: "screen_layout",
      section: `function:${screen.primary_function_id}`,
      owner_kind: "screen",
      owner_id: screen.id,
      puml: puml("@startsalt", body, "@endsalt")
    }
  ]
}
