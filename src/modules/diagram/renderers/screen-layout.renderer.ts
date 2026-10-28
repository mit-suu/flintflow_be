/**
 * §3.x.y Screen Layout (salt) — source_fields: `screens[<owner>].name` ·
 * `functions[screen_id=<owner>].name/.description` (srs-spine §7.1).
 * Low-fi có chủ ý (Phases §7.2): màn có gì và làm gì, không phải trông ra sao.
 * Gắn vào `function:<primary_function_id>`; màn không có primary function ⇒ không render.
 */

import type { Renderer } from "./common.js"
import { compareIds, puml } from "./common.js"
import { DIAGRAM_LABELS } from "./labels.js"

/** Ô salt: bỏ ký tự điều khiển cú pháp salt (`| { } # [ ] < > "`). */
export const saltCell = (text: string): string => text.replace(/[|{}#[\]<>"^()]/g, " ").replace(/\s+/g, " ").trim()

export const MAX_DESCRIPTION_CHARS = 100

const clip = (text: string): string =>
  text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 3).trimEnd()}...` : text

/** Dòng tiêu đề bảng function theo từng bộ nhãn — `"<b>Function | <b>Description"` ở bản tiếng Anh. */
const FUNCTION_TABLE_HEADERS = Object.values(DIAGRAM_LABELS).map((l) => `<b>${l.functionColumn} | <b>${l.descriptionColumn}`)

/**
 * Salt là bảng Function | Description của renderer này (mọi ngôn ngữ — FLF-265 N1), không phải wireframe model vẽ:
 * mô tả giao diện (`render/interface-description.ts`) và chữ wireframe (`salt-text.ts`) bỏ qua bảng này.
 */
export const isFunctionTable = (source: string): boolean => FUNCTION_TABLE_HEADERS.some((header) => source.includes(header))

export const renderScreenLayout: Renderer = (spine, ownerId, labels = DIAGRAM_LABELS.en) => {
  const screen = spine.screens.find((s) => s.id === ownerId)
  if (!screen || screen.primary_function_id === null) return []

  const functions = spine.functions
    .filter((f) => f.screen_id === screen.id)
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
  const rows =
    functions.length > 0
      ? functions.map((f) => `    ${saltCell(f.name) || f.id} | ${clip(saltCell(f.description)) || "-"}`)
      : [`    - | ${labels.noFunctions}`]

  const body = ["{+", `  <b>${saltCell(screen.name) || screen.id}`, "  {#", `    <b>${labels.functionColumn} | <b>${labels.descriptionColumn}`, ...rows, "  }", "}"]

  return [
    {
      kind: "screen_layout",
      section: `function:${screen.primary_function_id}`,
      owner_kind: "screen",
      owner_id: screen.id,
      format: "puml",
      source: puml("@startsalt", body, "@endsalt")
    }
  ]
}
