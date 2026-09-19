/**
 * Dựng op Spine từ thực thể đã trích + xác nhận (finalize, nút 1.10). FLF-171, plan §6 2C. Hàm thuần.
 * Model chỉ trả JSON, code dựng op: mỗi phần tử là một `add` đầy đủ field theo `spineSchema` (điền mặc định,
 * ép enum), tham chiếu được phân giải theo id hoặc theo tên; tham chiếu không phân giải được bị bỏ (không đoán)
 * để bất biến 3 (khoá chết) không chặn cả lô. Màn/function không có feature ⇒ gom vào feature "General".
 */

import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { IdAllocator } from "./extracted-entities.js"

export interface BuiltEntity {
  entity: string
  id: string | null
  value: Record<string, unknown>
}

const str = (v: unknown): string => {
  if (typeof v === "string") return v.trim()
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join("\n")
  if (v === null || v === undefined) return ""
  return typeof v === "object" ? JSON.stringify(v) : String(v)
}


const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(str).filter(Boolean)
  const s = str(v)
  return s ? s.split(/\n+/).map((x) => x.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean) : []
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = str(v).toLowerCase()
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

const PRIORITIES = ["must", "should", "could", "wont"] as const
const priority = (v: unknown): (typeof PRIORITIES)[number] | null => {
  const s = str(v).toLowerCase()
  return (PRIORITIES as readonly string[]).includes(s) ? (s as (typeof PRIORITIES)[number]) : null
}

/** Dựng op cho Spine rỗng của project mode 1. Phần tử có id đã tồn tại trong `spine` bị bỏ qua. */
export const buildImportOps = (spine: Spine, entities: BuiltEntity[]): Op[] => {
  const of = (entity: string) => entities.filter((e) => e.entity === entity && e.id !== null)
  const existing = (arr: { id: string }[]) => new Set(arr.map((x) => x.id))
  const alloc = new IdAllocator({ features: existing(spine.features), functions: existing(spine.functions) })

  // Chỉ mục tên ⇒ id để phân giải tham chiếu ghi bằng tên (vd cột "Actor" của bảng UC)
  const resolver = (entity: string, pool: { id: string; name?: string }[]) => {
    const ids = new Set(pool.map((p) => p.id))
    const byName = new Map(pool.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p.id]))
    return (ref: unknown): string | null => {
      const s = str(ref)
      if (!s) return null
      if (ids.has(s)) return s
      return byName.get(s.toLowerCase()) ?? null
    }
  }
  const pool = (entity: string, spineArr: { id: string; name?: string }[]) => [
    ...spineArr,
    ...of(entity).map((e) => ({ id: e.id!, name: str(e.value.name ?? e.value.term) || undefined }))
  ]

  const resolveActor = resolver("actors", pool("actors", spine.actors))
  const resolveUseCase = resolver("use_cases", pool("use_cases", spine.use_cases))
  const resolveScreen = resolver("screens", pool("screens", spine.screens))
  const resolveRole = resolver("roles", pool("roles", spine.roles))
  const resolveEntity = resolver("entities", pool("entities", spine.entities))
  const resolveRule = resolver("business_rules", pool("business_rules", spine.business_rules as { id: string }[]))
  const featurePool = pool("features", spine.features)
  const resolveFeature = resolver("features", featurePool)

  const ops: Op[] = []
  const add = (path: string, value: object) => ops.push({ op: "add", path: `${path}[]`, value })
  const skip = (arr: { id: string }[]) => {
    const ids = existing(arr)
    return (e: BuiltEntity) => !ids.has(e.id!)
  }

  // project
  const project = entities.filter((e) => e.entity === "project").reduce<Record<string, unknown>>((acc, e) => ({ ...acc, ...e.value }), {})
  for (const field of ["vision", "type", "domain", "complexity", "form_factor", "stakes"] as const) {
    if (project[field] !== undefined && str(project[field])) ops.push({ op: "set", path: `project.${field}`, value: str(project[field]) })
  }
  if (project.goals !== undefined && strList(project.goals).length) ops.push({ op: "set", path: "project.goals", value: strList(project.goals) })

  // features (+ "General" cho màn/function mồ côi)
  const features = of("features").filter(skip(spine.features))
  let order = spine.features.length
  for (const f of features) add("features", { id: f.id, name: str(f.value.name) || f.id, order: order++ })
  let general: string | null = null
  const featureOr = (ref: unknown): string => {
    const hit = resolveFeature(ref)
    if (hit) return hit
    if (!general) {
      general = alloc.next("features")
      add("features", { id: general, name: "General", order: order++ })
    }
    return general
  }

  for (const a of of("actors").filter(skip(spine.actors))) {
    add("actors", { id: a.id, name: str(a.value.name) || a.id, kind: oneOf(a.value.kind, ["human", "system", "time"], "human"), description: str(a.value.description) })
  }
  for (const r of of("roles").filter(skip(spine.roles))) add("roles", { id: r.id, name: str(r.value.name) || r.id, actor_id: resolveActor(r.value.actor_id ?? r.value.actor) })
  for (const e of of("entities").filter(skip(spine.entities))) {
    add("entities", {
      id: e.id,
      name: str(e.value.name) || e.id,
      description: str(e.value.description),
      relations: strList(e.value.relations).map(resolveEntity).filter((x): x is string => !!x && x !== e.id)
    })
  }
  for (const b of of("business_rules").filter(skip(spine.business_rules))) {
    add("business_rules", { id: b.id, tier: oneOf(b.value.tier, ["high", "detail"], "detail"), statement: str(b.value.statement ?? b.value.rule ?? b.value.description), source_validation_ids: [] })
  }
  for (const s of of("screens").filter(skip(spine.screens))) {
    add("screens", {
      id: s.id,
      feature_id: featureOr(s.value.feature_id),
      name: str(s.value.name) || s.id,
      description: str(s.value.description),
      flow_to: strList(s.value.flow_to).map(resolveScreen).filter((x): x is string => !!x && x !== s.id),
      is_popup: s.value.is_popup === true,
      tabs: strList(s.value.tabs),
      primary_function_id: null,
      queue_order: null,
      detail_status: "signed_off"
    })
  }
  // functions: order duy nhất trong (feature, có màn / không màn)
  const orderIn = new Map<string, number>()
  for (const f of of("functions").filter(skip(spine.functions))) {
    const screenId = resolveScreen(f.value.screen_id)
    const featureId = screenId ? featureOf(ops, screenId) ?? featureOr(f.value.feature_id) : featureOr(f.value.feature_id)
    const group = `${featureId}|${screenId ? "screen" : "nonscreen"}`
    const fnOrder = orderIn.get(group) ?? 0
    orderIn.set(group, fnOrder + 1)
    const validations = Array.isArray(f.value.validations) ? f.value.validations : []
    add("functions", {
      id: f.id,
      screen_id: screenId,
      feature_id: featureId,
      order: fnOrder,
      name: str(f.value.name) || f.id,
      trigger: str(f.value.trigger),
      description: str(f.value.description),
      normal: strList(f.value.normal),
      abnormal: strList(f.value.abnormal),
      validations: validations
        .map((v, i) => {
          const o = (typeof v === "object" && v ? v : { statement: v }) as Record<string, unknown>
          return { id: `${f.id}-V${i + 1}`, kind: oneOf(o.kind, ["business", "format", "required"], "business"), statement: str(o.statement) }
        })
        .filter((v) => v.statement),
      business_rule_ids: strList(f.value.business_rule_ids).map(resolveRule).filter((x): x is string => !!x),
      priority: priority(f.value.priority)
    })
  }
  const functionIds = new Set([...spine.functions.map((f) => f.id), ...of("functions").map((f) => f.id!)])
  for (const u of of("use_cases").filter(skip(spine.use_cases))) {
    add("use_cases", {
      id: u.id,
      name: str(u.value.name) || u.id,
      actor_ids: [...new Set(strList(u.value.actor_ids ?? u.value.actors).map(resolveActor).filter((x): x is string => !!x))],
      function_ids: strList(u.value.function_ids).filter((x) => functionIds.has(x)),
      description: str(u.value.description),
      includes: strList(u.value.includes).map(resolveUseCase).filter((x): x is string => !!x && x !== u.id),
      extends: strList(u.value.extends).map(resolveUseCase).filter((x): x is string => !!x && x !== u.id)
    })
  }
  for (const p of of("permissions").filter(skip(spine.permissions))) {
    const screenId = resolveScreen(p.value.screen_id ?? p.value.screen)
    const roleId = resolveRole(p.value.role_id ?? p.value.role)
    const action = str(p.value.action)
    if (screenId && roleId && action) add("permissions", { id: p.id, screen_id: screenId, role_id: roleId, action })
  }
  for (const n of of("nfrs").filter(skip(spine.nfrs))) {
    const statement = str(n.value.statement ?? n.value.description)
    const value: Record<string, unknown> = {
      id: n.id,
      category: oneOf(n.value.category, ["interface", "usability", "reliability", "performance", "other"], "other"),
      statement,
      kind: oneOf(n.value.kind, ["quantitative", "descriptive"], /\d/.test(statement) ? "quantitative" : "descriptive"),
      priority: priority(n.value.priority)
    }
    if (str(n.value.metric)) value.metric = str(n.value.metric)
    if (str(n.value.threshold)) value.threshold = str(n.value.threshold)
    add("nfrs", value)
  }
  for (const c of of("common_requirements").filter(skip(spine.common_requirements))) {
    add("common_requirements", { id: c.id, category: str(c.value.category) || "General", statement: str(c.value.statement ?? c.value.description) })
  }
  for (const m of of("messages").filter(skip(spine.messages))) {
    add("messages", { id: m.id, code: str(m.value.code) || m.id!, text: str(m.value.text ?? m.value.message), function_ids: [] })
  }
  for (const o of of("other_requirements").filter(skip(spine.other_requirements))) {
    add("other_requirements", {
      id: o.id,
      kind: oneOf(o.value.kind, ["risk", "assumption", "open_question", "technical_risk"], "assumption"),
      statement: str(o.value.statement ?? o.value.description)
    })
  }
  for (const g of of("glossary").filter(skip(spine.glossary))) {
    add("glossary", { id: g.id, term: str(g.value.term ?? g.value.name) || g.id, definition: str(g.value.definition ?? g.value.description) })
  }
  return ops
}

/** Feature của màn vừa được thêm trong cùng lô. */
const featureOf = (ops: Op[], screenId: string): string | null => {
  const op = ops.find((o) => o.path === "screens[]" && (o.value as { id: string }).id === screenId)
  return op ? (op.value as { feature_id: string }).feature_id : null
}
