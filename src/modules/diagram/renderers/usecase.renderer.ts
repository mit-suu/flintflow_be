/**
 * §2.2.1 Use Case Diagram — source_fields: `actors[].name/.kind` ·
 * `use_cases[].name/.actor_ids/.includes/.extends` (srs-spine §7.1).
 *
 * Cạnh actor–use case là association (`--`, không đầu mũi tên): đầu mũi tên trên association
 * nghĩa là navigability, không phải "ai gọi ai".
 *
 * Use case mở rộng (`extends[]`) hoặc bị use case khác include KHÔNG nối thẳng vào actor NGƯỜI —
 * actor đến với nó qua use case gốc, nối thẳng làm nó trông như use case độc lập. Ngoại lệ:
 * actor mà mọi cạnh đều bị bỏ vẫn giữ một cạnh, nếu không nó biến khỏi hình trong khi vẫn
 * nằm ở bảng §2.1. Actor `system`/`time` luôn giữ cạnh: nó tham gia đúng phần việc của use case
 * mở rộng (cổng thanh toán ở "Pay Deposit"), bỏ cạnh làm mất vai trò của nó trên hình.
 *
 * Bố cục (`left to right direction`): PHÍA của actor do CHIỀU cạnh quyết định, không do thứ tự
 * khai báo — actor người viết `A -- UC` (trái), actor system/time viết `UC -- A` (phải). Use case
 * phát theo nhóm actor người chính rồi theo id, nên use case của cùng một actor đứng cạnh nhau.
 *
 * Quá trần (số use case hoặc số cạnh association) ⇒ tách nhiều hình. Đơn vị dồn là NHÓM actor
 * người chính (mỗi actor nằm trọn một hình khi vừa), bên trong là CỤM quan hệ (thành phần liên
 * thông của đồ thị include/extend) nên cạnh quan hệ không rơi mất ở ranh giới; nhóm vượt trần mới
 * cắt theo cụm, cụm vượt trần cứng mới cắt theo lô, và `inPart` bỏ cạnh vắt qua ranh giới ở đúng
 * ca đó. Tiêu đề phần nêu actor chính của các nhóm trong phần.
 */

import type { ActorKind, UseCase } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

export const MAX_USE_CASES_PER_DIAGRAM = 20

/**
 * Trần số cạnh actor–use case của một hình. Đo trên sơ đồ thật: > ~30 cạnh thì Graphviz vắt dây
 * chéo khắp hình dù use case chưa tới 20 (CampShare 17 UC/31 cạnh, ShipNhanh phần 1 20 UC/30 cạnh).
 */
export const MAX_ASSOCIATIONS_PER_DIAGRAM = 24

/** Loại actor theo id — renderer cần để chọn phía và luật bỏ cạnh. Id lạ coi như không phải người. */
export type ActorKinds = ReadonlyMap<string, ActorKind>

const isHuman = (kinds: ActorKinds, actorId: string): boolean => kinds.get(actorId) === "human"

/**
 * Trần cứng cho một cụm quan hệ. Cụm dài hơn mức này bị cắt theo lô như trước: một `.puml`
 * quá lớn làm PlantUML lỗi ⇒ `render_error`, cờ đỏ không waive được, user không có đường gỡ.
 */
export const MAX_CLUSTER_SPAN = MAX_USE_CASES_PER_DIAGRAM * 2

const STEREOTYPE: Readonly<Record<string, string>> = { human: "", system: " <<system>>", time: " <<time>>" }

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export interface UseCasePart {
  useCases: UseCase[]
  /** Actor đại diện của từng cụm trong phần, theo thứ tự dồn — dùng dựng tiêu đề. */
  groupKeys: string[]
}

/** Thành phần liên thông của đồ thị include/extend (vô hướng); cụm vượt trần cứng bị cắt theo lô. */
export const relationClusters = (useCases: readonly UseCase[]): UseCase[][] => {
  const sorted = byId(useCases)
  const known = new Map(sorted.map((u) => [u.id, u]))
  const neighbours = new Map<string, string[]>(sorted.map((u) => [u.id, []]))
  for (const uc of sorted) {
    for (const other of [...uc.includes, ...uc.extends]) {
      // Id chết là việc của cờ đỏ `dead_reference`; ở đây bỏ qua để đồ thị luôn hợp lệ.
      if (other === uc.id || !known.has(other)) continue
      neighbours.get(uc.id)!.push(other)
      neighbours.get(other)!.push(uc.id)
    }
  }

  const seen = new Set<string>()
  const clusters: UseCase[][] = []
  for (const root of sorted) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    const queue = [root.id]
    const members: UseCase[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      members.push(known.get(id)!)
      for (const next of [...new Set(neighbours.get(id) ?? [])].sort(compareIds)) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    const ordered = byId(members)
    clusters.push(...(ordered.length > MAX_CLUSTER_SPAN ? chunks(ordered, MAX_USE_CASES_PER_DIAGRAM) : [ordered]))
  }
  return clusters
}

/**
 * Khoá nhóm của một cụm: actor NGƯỜI đầu tiên (use case theo id, `actor_ids` giữ thứ tự — actor
 * chính đứng đầu). Không có actor người ⇒ actor có id nhỏ nhất. Không dùng "id nhỏ nhất" cho mọi
 * cụm vì actor system được thêm sớm (S-2.3) nên id nhỏ — nhóm theo nó xé use case của một actor
 * người qua nhiều hình.
 */
const clusterKey = (cluster: readonly UseCase[], kinds: ActorKinds): string => {
  const ids = cluster.flatMap((u) => u.actor_ids)
  return ids.find((id) => isHuman(kinds, id)) ?? [...new Set(ids)].sort(compareIds)[0] ?? "~"
}

/**
 * Thứ tự phát và cách chia hình: nhóm actor chính (theo id actor) → cụm quan hệ → id use case.
 * Vừa trần ⇒ một phần không tiêu đề. Quá trần ⇒ dồn NGUYÊN nhóm vào từng hình tới khi đầy; nhóm
 * tự nó vượt trần mới cắt theo cụm; cụm vượt trần cứng đã bị `relationClusters` cắt theo lô.
 * `kinds` rỗng ⇒ không biết actor nào ⇒ chỉ xét trần số use case.
 */
export const partitionUseCases = (useCases: UseCase[], kinds: ActorKinds = new Map()): UseCasePart[] => {
  const kept = associationEdges(useCases, kinds)
  const edgeCount = (ucs: readonly UseCase[]): number =>
    ucs.reduce((n, uc) => n + [...new Set(uc.actor_ids)].filter((a) => kept.has(`${a}|${uc.id}`)).length, 0)
  const fits = (ucs: readonly UseCase[]): boolean =>
    ucs.length <= MAX_USE_CASES_PER_DIAGRAM && edgeCount(ucs) <= MAX_ASSOCIATIONS_PER_DIAGRAM

  const groups = new Map<string, UseCase[][]>()
  for (const cluster of relationClusters(useCases)) {
    const key = clusterKey(cluster, kinds)
    groups.set(key, [...(groups.get(key) ?? []), cluster])
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => compareIds(a, b))
  if (fits(useCases)) return [{ useCases: ordered.flatMap(([, clusters]) => clusters.flat()), groupKeys: [] }]

  const parts: UseCasePart[] = []
  let current: UseCasePart = { useCases: [], groupKeys: [] }
  const place = (key: string, ucs: UseCase[]): void => {
    if (current.useCases.length > 0 && !fits([...current.useCases, ...ucs])) {
      parts.push(current)
      current = { useCases: [], groupKeys: [] }
    }
    current.useCases.push(...ucs)
    if (!current.groupKeys.includes(key)) current.groupKeys.push(key)
  }
  for (const [key, clusters] of ordered) {
    const whole = clusters.flat()
    if (fits(whole)) place(key, whole)
    else for (const cluster of clusters) place(key, cluster)
  }
  if (current.useCases.length > 0) parts.push(current)
  return parts
}

/** Use case không đứng độc lập trên hình: có `extends[]` hoặc bị use case khác include. */
export const dependentUseCaseIds = (useCases: readonly UseCase[]): Set<string> => {
  const included = new Set(useCases.flatMap((u) => u.includes))
  return new Set(useCases.filter((u) => u.extends.length > 0 || included.has(u.id)).map((u) => u.id))
}

/** Số use case PHÂN BIỆT mà mỗi actor tham gia — actor chỉ có đúng một thì cạnh của nó được giữ. */
export const actorUseCaseCounts = (useCases: readonly UseCase[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const uc of useCases) for (const id of new Set(uc.actor_ids)) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

/**
 * Cạnh association được giữ lại, dạng `${actorId}|${useCaseId}`. Tính trên TOÀN BỘ use case
 * chứ không trên từng phần: một use case có thể bị include bởi use case ở phần khác, và actor
 * có thể tham gia use case ở phần khác.
 */
const associationEdges = (useCases: readonly UseCase[], kinds: ActorKinds): Set<string> => {
  const dependent = dependentUseCaseIds(useCases)
  const counts = actorUseCaseCounts(useCases)
  const kept = new Set<string>()
  const byActor = new Map<string, string[]>()

  for (const uc of byId(useCases)) {
    for (const actorId of [...new Set(uc.actor_ids)].sort(compareIds)) {
      if (!kinds.has(actorId)) continue
      byActor.set(actorId, [...(byActor.get(actorId) ?? []), uc.id])
      if (isHuman(kinds, actorId) && dependent.has(uc.id) && (counts.get(actorId) ?? 0) > 1) continue
      kept.add(`${actorId}|${uc.id}`)
    }
  }

  // Actor mà mọi cạnh đều bị bỏ sẽ không còn được khai báo ⇒ biến khỏi hình. Khôi phục cạnh
  // tới use case có id nhỏ nhất mà actor đó tham gia.
  for (const [actorId, ucIds] of byActor) {
    if (ucIds.some((ucId) => kept.has(`${actorId}|${ucId}`))) continue
    const fallback = [...ucIds].sort(compareIds)[0]
    if (fallback !== undefined) kept.add(`${actorId}|${fallback}`)
  }
  return kept
}

export const renderUseCase: Renderer = (spine) => {
  const actors = new Map(spine.actors.map((a) => [a.id, a]))
  const kinds: ActorKinds = new Map(spine.actors.map((a) => [a.id, a.kind]))
  const parts = partitionUseCases(byId(spine.use_cases), kinds)
  const system = label(spine.project.name) || "System"
  const kept = associationEdges(spine.use_cases, kinds)
  // Tên actor không bị ràng buộc ở schema ⇒ phải qua `label()`, `"` hay xuống dòng làm vỡ `.puml`.
  const groupLabel = (key: string): string => label(actors.get(key)?.name ?? (key === "~" ? "Other" : key))
  const declare = (id: string): string[] => {
    const actor = actors.get(id)
    return actor ? [`actor "${label(actor.name)}" as ${alias(actor.id)}${STEREOTYPE[actor.kind] ?? ""}`] : []
  }

  return parts.map((part) => {
    // Thứ tự do `partitionUseCases` quyết định (nhóm actor → cụm → id) — vẫn tất định nên giữ
    // hợp đồng "cùng Spine ⇒ cùng text" (common.ts).
    const useCases = part.useCases
    const inPart = new Set(useCases.map((u) => u.id))
    const edges = useCases.flatMap((uc) =>
      [...new Set(uc.actor_ids)]
        .sort(compareIds)
        .filter((actorId) => kept.has(`${actorId}|${uc.id}`))
        .map((actorId) => ({ actorId, useCaseId: uc.id }))
    )
    const actorIds = [...new Set(edges.map((e) => e.actorId))].sort(compareIds)
    const body = ["skinparam monochrome true", "left to right direction"]
    if (parts.length > 1) body.push(`title Use Cases — ${part.groupKeys.map(groupLabel).join(" / ")}`)

    body.push(...actorIds.filter((id) => isHuman(kinds, id)).flatMap(declare))
    body.push(`rectangle "${system}" {`)
    for (const uc of useCases) body.push(`  usecase "${label(uc.name)}" as ${alias(uc.id)}`)
    body.push("}")
    body.push(...actorIds.filter((id) => !isHuman(kinds, id)).flatMap(declare))

    for (const { actorId, useCaseId } of edges) {
      const [a, uc] = [alias(actorId), alias(useCaseId)]
      body.push(isHuman(kinds, actorId) ? `${a} -- ${uc}` : `${uc} -- ${a}`)
    }
    for (const uc of useCases) {
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
