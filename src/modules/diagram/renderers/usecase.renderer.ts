/**
 * §2.2.1 Use Case Diagram — source_fields: `actors[].name/.kind` ·
 * `use_cases[].name/.actor_ids/.includes/.extends` (srs-spine §7.1).
 *
 * Cạnh actor–use case là association (`--`, không đầu mũi tên): đầu mũi tên trên association
 * nghĩa là navigability, không phải "ai gọi ai".
 *
 * MỖI ACTOR NGƯỜI MỘT HÌNH (`partitionUseCases`): trong một hình, mỗi use case chỉ nối với đúng actor
 * người của hình đó — không bao giờ hai actor người cùng nối một use case trên một hình. Use case nhiều vai
 * trò dùng chung được lặp ở hình của từng vai trò. Actor `system`/`time` là actor phụ, luôn giữ cạnh.
 *
 * Use case mở rộng (`extends[]`) hoặc bị include KHÔNG nối thẳng vào actor người khi use case gốc nằm cùng
 * hình — actor đến với nó qua gốc. Gốc ở hình khác ⇒ giữ cạnh, nếu không use case lơ lửng.
 *
 * Bố cục (`left to right direction`): PHÍA của actor do CHIỀU cạnh quyết định — actor người viết `A -- UC`
 * (trái), actor system/time viết `UC -- A` (phải).
 *
 * Generalization (`actors[].parent_id`, chỉ người ↔ người): use case mà MỌI dạng chuyên biệt của một
 * actor tổng quát cùng làm được NÂNG lên actor tổng quát (`User`) và chỉ vẽ ở hình `User`; actor con thừa
 * kế. Use case chỉ chung một phần vai trò không nâng. Hình actor con vẽ `User <|-- Customer` (cùng nghĩa
 * `Customer --|> User`; cha viết trước để đứng ngoài cùng bên trái).
 */

import { systemName } from "../../spine/system-name.js"
import { actorParents, ancestorsOf } from "../../spine/actor-generalization.js"
import type { ActorKind, UseCase } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"
import { DIAGRAM_LABELS } from "./labels.js"

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

/** `actor con → actor cha`, chỉ cạnh hợp lệ (`actorParents`). Rỗng ⇒ sơ đồ như khi chưa có generalization. */
export type ActorParents = ReadonlyMap<string, string>

/**
 * `actor_ids` sau khi nâng: các actor người cùng một cây kế thừa được thay bằng tổ tiên chung gần nhất,
 * đặt ở vị trí actor đầu tiên của nhóm — actor chính vẫn đứng đầu. CHỈ nâng khi điều đó đúng nghĩa
 * "mọi dạng của actor tổng quát đều làm được": tổ tiên chung có mặt sẵn (actor con đi kèm là thừa), hoặc
 * các actor phủ ĐỦ mọi con trực tiếp của nó. Use case chỉ chung cho một phần vai trò (View Timetable của
 * Lecturer + Student, không có Office) giữ nguyên — nâng lên `User` sẽ nói sai rằng Office cũng làm được.
 * Actor system/time và actor ngoài cây giữ nguyên.
 */
export const liftToGeneral = (actorIds: readonly string[], kinds: ActorKinds, parents: ActorParents): string[] => {
  const unique = [...new Set(actorIds)]
  const chainOf = (id: string): string[] => [id, ...ancestorsOf(id, parents)]
  const rootOf = (id: string): string => { const chain = chainOf(id); return chain[chain.length - 1]! }
  const families = new Map<string, string[]>()
  for (const id of unique) {
    if (!isHuman(kinds, id)) continue
    families.set(rootOf(id), [...(families.get(rootOf(id)) ?? []), id])
  }

  const childrenOf = (id: string): string[] => [...parents].filter(([, p]) => p === id).map(([c]) => c)
  const replaced = new Map<string, string>()
  for (const members of families.values()) {
    if (members.length < 2) continue
    // Tổ tiên chung gần nhất: phần tử đầu tiên trong chuỗi của actor đầu mà mọi actor khác cũng đi qua.
    const chains = members.map((m) => new Set(chainOf(m)))
    const common = chainOf(members[0]!).find((a) => chains.every((c) => c.has(a)))
    if (common === undefined) continue
    const coversAll = childrenOf(common).every((child) => chains.some((c) => c.has(child)))
    if (members.includes(common) || coversAll) for (const m of members) replaced.set(m, common)
  }
  return [...new Set(unique.map((id) => replaced.get(id) ?? id))]
}

/** Use case với `actor_ids` đã nâng — đầu vào chung của chia hình và cạnh khi có generalization. */
const liftUseCases = (useCases: readonly UseCase[], kinds: ActorKinds, parents: ActorParents): UseCase[] =>
  parents.size === 0 ? [...useCases] : useCases.map((u) => ({ ...u, actor_ids: liftToGeneral(u.actor_ids, kinds, parents) }))

export interface UseCasePart {
  useCases: UseCase[]
  /** Cạnh association vẽ trong phần này, dạng `${actorId}|${useCaseId}`. */
  keep: Set<string>
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
 * Chia hình: MỖI ACTOR NGƯỜI MỘT HÌNH, mỗi use case trong hình chỉ nối với đúng actor người đó (cộng
 * actor system/time tham gia — actor phụ). Hình của actor H gồm use case H tham gia + những gì chúng
 * `include` + những use case `extend` chúng (đệ quy); KHÔNG kéo ngược lên use case gốc của vai trò khác
 * (Founder tham gia Verify Document mà Sign Baseline của Business Analyst include ⇒ hình Founder không
 * có Sign Baseline). Use case chung cho nhiều vai trò (View Timetable của Lecturer + Student) xuất hiện ở
 * hình của TỪNG vai trò.
 *
 * Cạnh H → use case phụ thuộc (bị include / extend) chỉ bỏ khi use case gốc của nó cũng nằm trong hình:
 * H đến với nó qua gốc. Gốc ở hình khác ⇒ giữ cạnh, nếu không use case lơ lửng. H không còn cạnh nào ⇒ giữ
 * cạnh tới use case có id nhỏ nhất của H.
 *
 * Phần còn lại (use case không actor người nào chạm tới: việc của scheduler, hệ thống ngoài) gom theo cụm
 * quan hệ, khoá actor đầu tiên của cụm. Thứ tự hình: actor tổng quát → actor chuyên biệt (theo độ sâu) →
 * actor người ngoài cây kế thừa → nhóm không có actor người; cùng hạng thì theo id. Một hình vượt trần
 * (số use case / số cạnh) ⇒ cắt theo cụm quan hệ. `useCases` phải đã qua `liftUseCases` khi có `parents`.
 */
export const partitionUseCases = (useCases: UseCase[], kinds: ActorKinds = new Map(), parents: ActorParents = new Map()): UseCasePart[] => {
  const known = new Map(useCases.map((u) => [u.id, u]))
  const extensionsOf = new Map<string, string[]>()
  for (const u of useCases) for (const base of u.extends) if (known.has(base) && base !== u.id) extensionsOf.set(base, [...(extensionsOf.get(base) ?? []), u.id])

  /** Use case của actor + include + extension, đệ quy. */
  const closure = (seed: readonly string[]): Set<string> => {
    const set = new Set(seed)
    const queue = [...seed]
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const next of [...(known.get(id)?.includes ?? []), ...(extensionsOf.get(id) ?? [])]) {
        if (!known.has(next) || set.has(next)) continue
        set.add(next)
        queue.push(next)
      }
    }
    return set
  }
  const nonHumanEdges = (ucs: readonly UseCase[]): string[] =>
    ucs.flatMap((uc) => [...new Set(uc.actor_ids)].filter((a) => kinds.has(a) && !isHuman(kinds, a)).map((a) => `${a}|${uc.id}`))
  const fits = (ucs: readonly UseCase[], keep: ReadonlySet<string>): boolean => {
    const ids = new Set(ucs.map((u) => u.id))
    return ucs.length <= MAX_USE_CASES_PER_DIAGRAM && [...keep].filter((k) => ids.has(k.split("|")[1]!)).length <= MAX_ASSOCIATIONS_PER_DIAGRAM
  }
  /** Phần vượt trần ⇒ cắt theo cụm quan hệ của chính tập use case trong phần. */
  const pack = (key: string, ucs: UseCase[], keep: Set<string>): UseCasePart[] => {
    if (fits(ucs, keep)) return [{ useCases: ucs, groupKeys: [key], keep }]
    const out: UseCasePart[] = []
    for (const cluster of relationClusters(ucs)) {
      const last = out[out.length - 1]
      if (last && fits([...last.useCases, ...cluster], keep)) last.useCases.push(...cluster)
      else out.push({ useCases: [...cluster], groupKeys: [key], keep })
    }
    return out
  }

  const general = new Set(parents.values())
  const rank = (key: string): number => {
    if (parents.has(key) || general.has(key)) return ancestorsOf(key, parents).length
    return isHuman(kinds, key) ? 1_000 : 2_000
  }
  const humans = [...new Set(useCases.flatMap((u) => u.actor_ids).filter((a) => isHuman(kinds, a)))]
  const groups: [string, UseCase[], Set<string>][] = []
  const covered = new Set<string>()

  for (const h of humans) {
    const own = useCases.filter((u) => u.actor_ids.includes(h)).map((u) => u.id)
    const inPart = closure(own)
    const ucs = useCases.filter((u) => inPart.has(u.id))
    const reachedViaBase = (uc: UseCase): boolean =>
      ucs.some((o) => o.id !== uc.id && o.includes.includes(uc.id)) || uc.extends.some((b) => b !== uc.id && inPart.has(b))
    const keep = new Set(nonHumanEdges(ucs))
    const ownEdges = own.filter((id) => !reachedViaBase(known.get(id)!))
    for (const id of ownEdges.length > 0 ? ownEdges : [[...own].sort(compareIds)[0]!]) keep.add(`${h}|${id}`)
    for (const id of inPart) covered.add(id)
    groups.push([h, ucs, keep])
  }

  const rest = useCases.filter((u) => !covered.has(u.id))
  const restGroups = new Map<string, UseCase[]>()
  for (const cluster of relationClusters(rest)) {
    const key = clusterKey(cluster, kinds)
    restGroups.set(key, [...(restGroups.get(key) ?? []), ...cluster])
  }
  for (const [key, ucs] of restGroups) groups.push([key, ucs, new Set(nonHumanEdges(ucs))])

  return groups
    .sort(([a], [b]) => rank(a) - rank(b) || compareIds(a, b))
    .flatMap(([key, ucs, keep]) => pack(key, ucs, keep))
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

export const renderUseCase: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) => {
  const actors = new Map(spine.actors.map((a) => [a.id, a]))
  const kinds: ActorKinds = new Map(spine.actors.map((a) => [a.id, a.kind]))
  const parents: ActorParents = actorParents(spine.actors)
  const lifted = liftUseCases(spine.use_cases, kinds, parents)
  const parts = partitionUseCases(byId(lifted), kinds, parents)
  const system = label(systemName(spine.project)) || labels.system
  const withEdge = new Set(parts.flatMap((p) => [...p.keep].map((k) => k.split("|")[0]!)))
  // Actor con không còn use case riêng (mọi use case đã nâng lên cha) ⇒ vẽ kèm kế thừa ở hình đầu tiên của cha.
  const strays = [...parents.keys()].filter((id) => !withEdge.has(id)).sort(compareIds)
  const firstPartOf = (actorId: string): number => parts.findIndex((p) => p.groupKeys.includes(actorId))
  // Tên actor không bị ràng buộc ở schema ⇒ phải qua `label()`, `"` hay xuống dòng làm vỡ `.puml`.
  const groupLabel = (key: string): string => label(actors.get(key)?.name ?? (key === "~" ? labels.otherGroup : key))
  const declare = (id: string): string[] => {
    const actor = actors.get(id)
    return actor ? [`actor "${label(actor.name)}" as ${alias(actor.id)}${STEREOTYPE[actor.kind] ?? ""}`] : []
  }

  return parts.map((part, partIndex) => {
    // Thứ tự do `partitionUseCases` quyết định (actor → cụm → id) — vẫn tất định nên giữ
    // hợp đồng "cùng Spine ⇒ cùng text" (common.ts).
    const owner = part.groupKeys[0]!
    const useCases = part.useCases
    const inPart = new Set(useCases.map((u) => u.id))
    // Một actor người mỗi hình: `keep` chỉ chứa cạnh của actor sở hữu hình + cạnh actor system/time (actor phụ).
    const edges = useCases.flatMap((uc) =>
      [...new Set(uc.actor_ids)]
        .sort(compareIds)
        .filter((actorId) => part.keep.has(`${actorId}|${uc.id}`))
        .map((actorId) => ({ actorId, useCaseId: uc.id }))
    )
    const children = [
      ...new Set([
        ...(parents.has(owner) && edges.some((e) => e.actorId === owner) ? [owner] : []),
        ...strays.filter((id) => {
          const home = firstPartOf(parents.get(id)!)
          return home === partIndex || (home < 0 && partIndex === 0)
        })
      ])
    ].sort(compareIds)
    const actorIds = [...new Set([...edges.map((e) => e.actorId), ...children, ...children.map((id) => parents.get(id)!)])].sort(compareIds)
    const body = ["skinparam monochrome true", "left to right direction"]
    if (parts.length > 1) body.push(`title ${labels.useCasesTitle(part.groupKeys.map(groupLabel).join(" / "))}`)

    body.push(...actorIds.filter((id) => isHuman(kinds, id)).flatMap(declare))
    body.push(`rectangle "${system}" {`)
    for (const uc of useCases) body.push(`  usecase "${label(uc.name)}" as ${alias(uc.id)}`)
    body.push("}")
    body.push(...actorIds.filter((id) => !isHuman(kinds, id)).flatMap(declare))

    for (const child of children) body.push(`${alias(parents.get(child)!)} <|-- ${alias(child)}`)
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
