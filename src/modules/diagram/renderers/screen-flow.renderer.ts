/**
 * §3.1.1 Screens Flow — source_fields: `screens[].name/.flow_to/.is_popup/.tabs` (srs-spine §7.1).
 * Màn có `tabs[]` ⇒ composite state (mỗi tab một sub-state `<screen>_T<n>`); `is_popup` ⇒ note.
 */

import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

export const renderScreenFlow: Renderer = (spine) => {
  const screens = byId(spine.screens)
  const ids = new Set(screens.map((s) => s.id))
  const body = ["skinparam monochrome true", "hide empty description"]

  if (screens.length === 0) {
    body.push('state "No screens yet" as NO_SCREENS')
  } else {
    const start = [...screens].sort(
      (a, b) => (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || compareIds(a.id, b.id)
    )[0]
    body.push(`[*] --> ${alias(start.id)}`)
  }

  for (const s of screens) {
    if (s.tabs.length === 0) {
      body.push(`state "${label(s.name)}" as ${alias(s.id)}`)
      continue
    }
    body.push(`state "${label(s.name)}" as ${alias(s.id)} {`)
    s.tabs.forEach((tab, i) => body.push(`  state "${label(tab)}" as ${alias(s.id)}_T${i + 1}`))
    body.push("}")
  }
  for (const s of screens) if (s.is_popup) body.push(`note right of ${alias(s.id)} : pop-up`)
  for (const s of screens) {
    for (const target of [...new Set(s.flow_to)].sort(compareIds)) {
      if (ids.has(target)) body.push(`${alias(s.id)} --> ${alias(target)}`)
    }
  }

  return [{ kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
