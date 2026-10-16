/**
 * Generalization giữa actor (`actors[].parent_id`, UML `Customer --|> User`): actor con là một dạng
 * chuyên biệt của actor cha và THỪA KẾ mọi use case của cha. Chỉ actor người ↔ actor người — actor
 * system/time hay hai actor không liên quan không được nối bằng kế thừa.
 *
 * Một nơi duy nhất quyết định cạnh nào hợp lệ: renderer chỉ vẽ cạnh hợp lệ, deterministic check cờ
 * cạnh không hợp lệ (`actor_generalization_invalid`). Cạnh trỏ tới id không tồn tại là việc của
 * `dead_reference`, ở đây chỉ bị bỏ qua.
 */

import type { Actor } from "./spine.types.js"

export type GeneralizationProblem = "not_human" | "parent_not_human" | "self" | "cycle"

const rawParent = (a: Pick<Actor, "parent_id">): string | null => a.parent_id?.trim() || null

/** Lỗi của cạnh `actor → parent_id`, theo actor con. Actor không có `parent_id` hoặc trỏ id chết ⇒ không có mục. */
export const generalizationProblems = (actors: readonly Actor[]): Map<string, GeneralizationProblem> => {
  const byId = new Map(actors.map((a) => [a.id, a]))
  const problems = new Map<string, GeneralizationProblem>()
  for (const a of actors) {
    const parentId = rawParent(a)
    if (parentId === null) continue
    const parent = byId.get(parentId)
    if (parentId === a.id) problems.set(a.id, "self")
    else if (!parent) continue
    else if (a.kind !== "human") problems.set(a.id, "not_human")
    else if (parent.kind !== "human") problems.set(a.id, "parent_not_human")
  }
  // Vòng: đi ngược lên từ mỗi actor; quay lại chính nó ⇒ mọi actor trên vòng đều lỗi.
  for (const a of actors) {
    if (problems.has(a.id)) continue
    const seen = new Set<string>([a.id])
    let current = rawParent(a)
    while (current !== null && byId.has(current)) {
      if (current === a.id) {
        problems.set(a.id, "cycle")
        break
      }
      if (seen.has(current)) break
      seen.add(current)
      current = rawParent(byId.get(current)!)
    }
  }
  return problems
}

/** `actor con → actor cha` chỉ gồm cạnh hợp lệ (cả hai là người, cha tồn tại, không vòng). */
export const actorParents = (actors: readonly Actor[]): Map<string, string> => {
  const byId = new Map(actors.map((a) => [a.id, a]))
  const problems = generalizationProblems(actors)
  const parents = new Map<string, string>()
  for (const a of actors) {
    const parentId = rawParent(a)
    if (parentId !== null && byId.has(parentId) && !problems.has(a.id)) parents.set(a.id, parentId)
  }
  return parents
}

/** Tổ tiên của actor, gần nhất trước. */
export const ancestorsOf = (actorId: string, parents: ReadonlyMap<string, string>): string[] => {
  const out: string[] = []
  let current = parents.get(actorId)
  while (current !== undefined && !out.includes(current)) {
    out.push(current)
    current = parents.get(current)
  }
  return out
}
