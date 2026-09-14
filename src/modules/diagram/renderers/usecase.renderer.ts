/**
 * §2.2.1 Use Case Diagram — source_fields: `actors[].name/.kind` ·
 * `use_cases[].name/.actor_ids/.includes/.extends` (srs-spine §7.1).
 *
 * > 25 use case ⇒ tách nhiều hình theo nhóm actor chính (actor_id nhỏ nhất của use case),
 * mỗi hình ≤ 25 use case; include/extend chỉ vẽ khi hai đầu cùng hình.
 */

import type { UseCase } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

export const MAX_USE_CASES_PER_DIAGRAM = 25

const STEREOTYPE: Readonly<Record<string, string>> = { human: "", system: " <<system>>", time: " <<time>>" }

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

/** Chia use case theo nhóm actor chính, dồn nhóm vào hình tới khi đầy. */
export const partitionUseCases = (useCases: UseCase[]): UseCase[][] => {
  if (useCases.length <= MAX_USE_CASES_PER_DIAGRAM) return [useCases]

  const groups = new Map<string, UseCase[]>()
  for (const uc of useCases) {
    const key = [...uc.actor_ids].sort(compareIds)[0] ?? "~"
    groups.set(key, [...(groups.get(key) ?? []), uc])
  }

  const parts: UseCase[][] = []
  let current: UseCase[] = []
  for (const key of [...groups.keys()].sort(compareIds)) {
    for (const chunk of chunks(groups.get(key) ?? [], MAX_USE_CASES_PER_DIAGRAM)) {
      if (current.length + chunk.length > MAX_USE_CASES_PER_DIAGRAM && current.length > 0) {
        parts.push(current)
        current = []
      }
      current.push(...chunk)
    }
  }
  if (current.length > 0) parts.push(current)
  return parts
}

export const renderUseCase: Renderer = (spine) => {
  const actors = new Map(spine.actors.map((a) => [a.id, a]))
  const parts = partitionUseCases(byId(spine.use_cases))
  const system = label(spine.project.name) || "System"

  return parts.map((part, index) => {
    const inPart = new Set(part.map((u) => u.id))
    const actorIds = parts.length === 1 ? [...actors.keys()] : [...new Set(part.flatMap((u) => u.actor_ids))].filter((id) => actors.has(id))
    const body = ["skinparam monochrome true", "left to right direction"]
    if (parts.length > 1) body.push(`title Use Cases (part ${index + 1} of ${parts.length})`)

    for (const id of [...actorIds].sort(compareIds)) {
      const actor = actors.get(id)
      if (actor) body.push(`actor "${label(actor.name)}" as ${alias(actor.id)}${STEREOTYPE[actor.kind] ?? ""}`)
    }
    body.push(`rectangle "${system}" {`)
    for (const uc of part) body.push(`  usecase "${label(uc.name)}" as ${alias(uc.id)}`)
    body.push("}")

    for (const uc of part) {
      for (const actorId of [...uc.actor_ids].sort(compareIds)) {
        if (actors.has(actorId)) body.push(`${alias(actorId)} --> ${alias(uc.id)}`)
      }
    }
    for (const uc of part) {
      for (const included of [...uc.includes].sort(compareIds)) {
        if (inPart.has(included)) body.push(`${alias(uc.id)} ..> ${alias(included)} : <<include>>`)
      }
      for (const base of [...uc.extends].sort(compareIds)) {
        if (inPart.has(base)) body.push(`${alias(uc.id)} ..> ${alias(base)} : <<extend>>`)
      }
    }

    return { kind: "usecase" as const, section: "fixed:2.2.1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }
  })
}
