/**
 * §1 System Context — source_fields: `project.name` · `actors[kind≠human].name` (srs-spine §7.1).
 * Cạnh không có nhãn: nhãn tương tác không thuộc source_fields.
 */

import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"

const SYSTEM_ALIAS = "SYSTEM_"

export const renderContext: Renderer = (spine) => {
  const externals = byId(spine.actors.filter((a) => a.kind !== "human"))
  const body = [
    "skinparam monochrome true",
    "left to right direction",
    `rectangle "${label(spine.project.name) || "System"}" as ${SYSTEM_ALIAS}`,
    ...externals.map((a) => `rectangle "${label(a.name)}" as ${alias(a.id)}${a.kind === "time" ? " <<time>>" : " <<system>>"}`),
    ...externals.map((a) => `${SYSTEM_ALIAS} -- ${alias(a.id)}`)
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
