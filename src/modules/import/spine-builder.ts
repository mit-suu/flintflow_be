/**
 * Dựng op Spine từ thực thể đã trích + xác nhận (finalize, nút 1.10). FLF-171, plan §6 2C. Hàm thuần.
 * Model chỉ trả JSON, code dựng op: mỗi phần tử là một `add` đầy đủ field theo `spineSchema` (điền mặc định,
 * ép enum), tham chiếu được phân giải theo id hoặc theo tên; tham chiếu không phân giải được bị bỏ (không đoán)
 * để bất biến 3 (khoá chết) không chặn cả lô. Màn/function không có feature ⇒ gom vào feature "General".
 */

import type { Op } from "../spine/op.types.js"
import type { ActivityFlow, ActivityNode, ActivityNodeKind, EntityAttribute, EntityState, EntityTransition, FlowEdge, FunctionInteraction, Spine } from "../spine/spine.types.js"
import { IdAllocator, compactKey, idKey, nameKey } from "./extracted-entities.js"
import { foldText } from "./text-similarity.js"

export interface BuiltEntity {
  entity: string
  id: string | null
  value: Record<string, unknown>
  /** Mục của file mà phần tử được trích từ đó (FLF-361: cấp của business rule theo mục, không theo model đoán). */
  sections?: Iterable<string>
}

/**
 * FLF-361: cấp business rule theo mục chứa nó trong file — rule ở 5.1 Business Rules là `detail`, ở mục 1 (High-Level
 * Business Rules) là `high`. Model trích không thấy bố cục tài liệu nên hay đoán `high` cho rule "quan trọng" (FAP: khoá
 * tài khoản, mật khẩu ≥ 8 ký tự…) ⇒ rule bị in dưới mục 1 và biến mất khỏi 5.1 khi các mục đó dựng lại từ Spine.
 * Mục khác (mục chức năng…) ⇒ null, giữ cấp model ghi.
 */
const DETAIL_RULE_SECTIONS: ReadonlySet<string> = new Set(["fixed:5.1", "slot:business_rules"])
const HIGH_RULE_SECTIONS: ReadonlySet<string> = new Set(["fixed:1", "slot:high_rules"])
export const ruleTierOfSections = (sections: Iterable<string> | undefined): "high" | "detail" | null => {
  const list = [...(sections ?? [])]
  if (list.some((s) => DETAIL_RULE_SECTIONS.has(s))) return "detail"
  if (list.some((s) => HIGH_RULE_SECTIONS.has(s))) return "high"
  return null
}

/** Quyền bị bỏ khi dựng op vì màn / vai trò không khớp phần tử nào (FLF-252 — "Sell Statistics" có trong ma trận, không có màn). */
export interface DroppedPermission {
  screen: string
  role: string
  missing: "screen" | "role"
}

/**
 * Cờ vàng cho quyền bị bỏ (FLF-252): trước đây bỏ im lặng — người dùng không biết Admin mất quyền "Sell Statistics".
 * Gộp theo màn / vai trò, nói rõ phải làm gì; không in mã.
 */
export const droppedPermissionFindings = (
  dropped: readonly DroppedPermission[],
  blockIds: string[]
): { rule: string; section_id: string; message: string; block_ids: string[] }[] => {
  const byName = new Map<string, { missing: DroppedPermission["missing"]; others: Set<string> }>()
  for (const d of dropped) {
    const name = d.missing === "screen" ? d.screen : d.role
    if (!name) continue
    const cur = byName.get(`${d.missing}|${name}`) ?? { missing: d.missing, others: new Set<string>() }
    cur.others.add(d.missing === "screen" ? d.role : d.screen)
    byName.set(`${d.missing}|${name}`, cur)
  }
  return [...byName].map(([key, { missing, others }]) => {
    const name = key.slice(key.indexOf("|") + 1)
    const list = [...others].filter(Boolean).join(", ")
    const message =
      missing === "screen"
        ? `Bảng phân quyền có "${name}"${list ? ` (quyền của ${list})` : ""} nhưng phần mô tả màn hình không có màn này — quyền chưa vào dữ liệu; thêm màn hoặc sửa tên cho khớp qua change request`
        : `Bảng phân quyền có vai trò "${name}" không khớp vai trò / tác nhân nào — quyền${list ? ` trên ${list}` : ""} chưa vào dữ liệu; sửa tên cho khớp qua change request`
    return { rule: "unresolved_permission", section_id: "fixed:3.1.3", message, block_ids: blockIds }
  })
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

/**
 * `flow_to` đọc từ tài liệu: mỗi phần tử là tên / mã màn đích, hoặc `{ to, trigger?, guard? }` khi sơ đồ ghi nhãn trên
 * mũi tên (hành động) và trên nhánh rẽ (`[điều kiện]`). Màn đích không phân giải được, hoặc chính màn đó ⇒ bỏ; hai cạnh
 * cùng màn đích ⇒ gộp (cạnh sau bổ sung trigger / guard còn thiếu).
 */
const flowEdges = (value: unknown, resolveScreen: (ref: unknown) => string | null, selfId: string): FlowEdge[] => {
  const items: unknown[] = Array.isArray(value) ? value : strList(value)
  const byTo = new Map<string, FlowEdge>()
  for (const item of items) {
    const rec = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null
    const to = resolveScreen(rec ? (rec.to ?? rec.screen ?? rec.target) : item)
    if (!to || to === selfId) continue
    const trigger = rec ? str(rec.trigger ?? rec.action ?? rec.label).trim() : ""
    const guard = rec ? str(rec.guard ?? rec.condition).replace(/^[|]$/g, "").trim() : ""
    const prev = byTo.get(to)
    byTo.set(to, {
      to,
      ...((prev?.trigger ?? trigger) ? { trigger: prev?.trigger ?? trigger } : {}),
      ...((prev?.guard ?? guard) ? { guard: prev?.guard ?? guard } : {})
    })
  }
  return [...byTo.values()]
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = str(v).toLowerCase()
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

/** Khoá lỏng của tên: bỏ phần trong ngoặc và chữ chỉ loại ở cuối ("Screen", "Page", "màn hình"…). */
const looseKey = (name: string): string =>
  nameKey(name.replace(/\([^)]*\)/g, " "))
    .replace(/\s*\b(screen|page|form|dialog|popup|modal|man hinh|trang)$/, "")
    .trim()

/** Câu mô tả actor nói nó kế thừa actor khác (tiếng Anh / tiếng Việt), tới hết câu. */
const INHERITS = /\b(inherits?|inheriting|specialization of|is a kind of)\b|kế thừa|thừa hưởng/i

/** Chuỗi chỉ là mã phần tử (`F-09`, `UC01`, `FR-3.2`) — không dùng làm tên khi tạo phần tử mới. */
const CODE_LIKE = /^[A-Za-z]{1,6}[-_ ]?\d+(?:\.\d+)*$/

/** Chỉ mục khoá ⇒ id; hai phần tử khác nhau cùng khoá ⇒ `null` (không đoán). */
const uniqueIndex = (pool: readonly { id: string; name?: string }[], keyOf: (p: { id: string; name?: string }) => string): Map<string, string | null> => {
  const map = new Map<string, string | null>()
  for (const p of pool) {
    const k = keyOf(p)
    if (k) map.set(k, map.has(k) && map.get(k) !== p.id ? null : p.id)
  }
  return map
}

/**
 * Thuộc tính entity tài liệu / sơ đồ ghi: chuỗi (`email`) hoặc `{ name, kind, required, description }`. Trùng tên (không phân
 * biệt hoa thường) ⇒ giữ cái đầu; `kind` lạ ⇒ `plain`; thiếu `required` ⇒ bắt buộc.
 */
const attributesOf = (raw: unknown): EntityAttribute[] => {
  const out: EntityAttribute[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null
    const name = str(rec ? rec.name : item)
    if (!name || out.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue
    const description = rec ? str(rec.description) : ""
    out.push({ name, kind: oneOf(rec?.kind, ["key", "reference", "plain"], "plain"), required: rec?.required === false ? false : true, ...(description ? { description } : {}) })
  }
  return out
}

/**
 * Vòng đời entity tài liệu / sơ đồ ghi: `states` là chuỗi (`Pending`) hoặc `{ name, initial, final }`; `transitions` là
 * `{ from, to, event, guard, action }` với `from` / `to` là tên (hoặc id) trạng thái. Id trạng thái `<entity>-ST<n>` theo
 * thứ tự ghi; trùng tên giữ cái đầu; không ghi initial ⇒ trạng thái đầu là initial (chỉ giữ một initial). Chuyển có đầu
 * mút không khớp trạng thái nào, thiếu sự kiện, hoặc đi ra từ trạng thái final thì bỏ — không đoán.
 */
const lifecycleOf = (entityId: string, rawStates: unknown, rawTransitions: unknown): { states: EntityState[]; transitions: EntityTransition[] } => {
  const states: EntityState[] = []
  const flags = new Map<string, { initial: boolean; final: boolean }>()
  for (const item of Array.isArray(rawStates) ? rawStates : []) {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null
    const name = str(rec ? rec.name : item)
    if (!name || states.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue
    const id = `${entityId}-ST${states.length + 1}`
    states.push({ id, name })
    flags.set(id, { initial: rec?.initial === true, final: rec?.final === true })
  }
  if (states.length === 0) return { states: [], transitions: [] }
  const initialId = states.find((s) => flags.get(s.id)?.initial)?.id ?? states[0].id
  const out = states.map((s) => ({ ...s, ...(s.id === initialId ? { initial: true } : {}), ...(flags.get(s.id)?.final ? { final: true } : {}) }))
  const find = (ref: unknown): string | null => {
    const text = str(ref).toLowerCase()
    return text ? (out.find((s) => s.id.toLowerCase() === text || s.name.toLowerCase() === text)?.id ?? null) : null
  }
  const transitions: EntityTransition[] = []
  for (const item of Array.isArray(rawTransitions) ? rawTransitions : []) {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null
    const from = find(rec?.from)
    const to = find(rec?.to)
    const event = str(rec?.event ?? rec?.trigger).replace(/[,\[\]]/g, " ").replace(/\s+/g, " ").trim()
    if (!rec || !from || !to || !event || out.find((s) => s.id === from)?.final) continue
    if (transitions.some((t) => t.from === from && t.to === to && t.event === event)) continue
    const guard = str(rec.guard)
    const action = str(rec.action)
    transitions.push({ from, to, event, ...(guard ? { guard } : {}), ...(action ? { action } : {}) })
  }
  return { states: out, transitions }
}

const SYSTEM_END = "system"
const NODE_KINDS: readonly ActivityNodeKind[] = ["initial", "final", "action", "decision", "merge", "fork", "join"]
/** Chữ nằm trong selector của path (message, khoá) không chứa `,` `[` `]`. */
const selectorText = (v: unknown): string => str(v).replace(/[,[\]]/g, " ").replace(/\s+/g, " ").trim()

/**
 * FLF-390: message actor ↔ hệ thống đọc từ sơ đồ tuần tự: `from` / `to` là actor (mã / tên) hoặc `system`. Message không
 * có đúng một đầu `system`, actor không khớp, thiếu chữ hay trùng khoá ⇒ bỏ (không đoán). Nhánh lỗi thiếu guard ⇒ bỏ.
 */
const interactionsOf = (raw: unknown, resolveActor: (ref: string) => string | null): FunctionInteraction[] => {
  const out: FunctionInteraction[] = []
  const end = (ref: unknown): string | null => {
    const text = str(ref)
    if (!text) return null
    return /^(the\s+)?system$|^hệ thống$/i.test(text) ? SYSTEM_END : resolveActor(text)
  }
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const from = end(rec.from)
    const to = end(rec.to)
    const message = selectorText(rec.message)
    if (!from || !to || !message || (from === SYSTEM_END) === (to === SYSTEM_END)) continue
    const kind = oneOf(rec.kind, ["request", "response"], from === SYSTEM_END ? "response" : "request")
    const flow = oneOf(rec.flow, ["normal", "abnormal"], "normal")
    const guard = str(rec.guard)
    if (flow === "abnormal" && !guard) continue
    if (out.some((i) => i.from === from && i.to === to && i.message === message && i.kind === kind && i.flow === flow)) continue
    out.push({ from, to, message, kind, flow, ...(guard ? { guard } : {}) })
  }
  return out
}

/**
 * FLF-390: luồng xử lý đọc từ sơ đồ activity: nút `{ id (tạm, N1…), kind, name, lane }` ⇒ id `<use case>-AN<n>` theo thứ tự;
 * làn = actor (mã / tên) hoặc `system`, không khớp ⇒ bỏ làn. Flow nối hai nút có thật, không tự trỏ, không trùng.
 */
const activityOf = (ownerId: string, rawNodes: unknown, rawFlows: unknown, resolveActor: (ref: string) => string | null): { activity_nodes: ActivityNode[]; activity_flows: ActivityFlow[] } => {
  const nodes: ActivityNode[] = []
  const local = new Map<string, string>()
  for (const item of Array.isArray(rawNodes) ? rawNodes : []) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const kind = NODE_KINDS.find((k) => k === str(rec.kind).toLowerCase())
    if (!kind) continue
    const id = `${ownerId}-AN${nodes.length + 1}`
    const ref = str(rec.id)
    if (ref) local.set(ref.toLowerCase(), id)
    const name = str(rec.name)
    if (name && !local.has(name.toLowerCase())) local.set(name.toLowerCase(), id)
    const laneText = str(rec.lane)
    const lane = laneText ? (/^(the\s+)?system$|^hệ thống$/i.test(laneText) ? SYSTEM_END : resolveActor(laneText)) : null
    nodes.push({ id, kind, ...(name && kind !== "initial" && kind !== "final" ? { name } : {}), ...(lane ? { lane } : {}) })
  }
  if (!nodes.length) return { activity_nodes: [], activity_flows: [] }
  const find = (ref: unknown): string | null => {
    const text = str(ref).toLowerCase()
    return text ? (local.get(text) ?? nodes.find((n) => n.id.toLowerCase() === text)?.id ?? null) : null
  }
  const flows: ActivityFlow[] = []
  for (const item of Array.isArray(rawFlows) ? rawFlows : []) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const from = find(rec.from)
    const to = find(rec.to)
    if (!from || !to || from === to || flows.some((f) => f.from === from && f.to === to)) continue
    const guard = str(rec.guard).replace(/^\[|\]$/g, "").trim()
    flows.push({ from, to, ...(guard ? { guard } : {}) })
  }
  return { activity_nodes: nodes, activity_flows: flows }
}

/** Động từ quan hệ hợp lệ của Spine (`relation_verbs`): tiếng Anh viết thường. */
const RELATION_VERB = /^[a-z]+( [a-z]+)*$/

/**
 * Cụm quan hệ "động từ + Thực thể" (bảng ERD FlintFlow xuất ra: "teaches Schedule Slot") ⇒ thực thể có tên dài nhất
 * nằm ở cuối cụm + động từ đứng trước (giữ làm nhãn quan hệ khi là tiếng Anh thường). Không thực thể nào ⇒ `null`.
 */
export const relationPhrase = (ref: string, pool: { id: string; name?: string }[]): { id: string; verb: string } | null => {
  const key = nameKey(ref)
  const hits = pool
    .map((p) => ({ id: p.id, k: p.name ? nameKey(p.name) : "" }))
    .filter((p) => p.k && (key === p.k || key.endsWith(` ${p.k}`)))
    .sort((a, b) => b.k.length - a.k.length)
  if (!hits.length) return null
  // Động từ lấy từ chữ gốc (không lấy từ khoá đã bỏ dấu — "ghi nhận" không thành "ghi nhan")
  const words = ref.trim().split(/\s+/)
  const verb = words.slice(0, Math.max(0, words.length - hits[0].k.split(" ").length)).join(" ").toLowerCase()
  return { id: hits[0].id, verb: RELATION_VERB.test(verb) ? verb : "" }
}

const PRIORITIES = ["must", "should", "could", "wont"] as const
const priority = (v: unknown): (typeof PRIORITIES)[number] | null => {
  const s = str(v).toLowerCase()
  return (PRIORITIES as readonly string[]).includes(s) ? (s as (typeof PRIORITIES)[number]) : null
}

/**
 * Dựng op cho Spine rỗng của project mode 1. Phần tử có id đã tồn tại trong `spine` bị bỏ qua. Quyền không phân giải được
 * màn / vai trò ghi vào `dropped` để finalize đặt cờ.
 */
export const buildImportOps = (spine: Spine, entities: BuiltEntity[], dropped: DroppedPermission[] = []): Op[] => {
  const of = (entity: string) => entities.filter((e) => e.entity === entity && e.id !== null)
  const existing = (arr: { id: string }[]) => new Set(arr.map((x) => x.id))
  // Giữ chỗ cả id trích được trong lô — không thì feature "General" có thể nhận trùng F-01 của tài liệu (FLF-179)
  const ids = (entity: "features" | "functions" | "permissions") => [...existing(spine[entity]), ...of(entity).map((e) => e.id!)]
  const alloc = new IdAllocator({ features: ids("features"), functions: ids("functions"), permissions: ids("permissions") })

  // Chỉ mục tên ⇒ id để phân giải tham chiếu ghi bằng tên (vd cột "Actor" của bảng UC). So tên đã chuẩn hoá (FLF-251):
  // cột Feature ghi "3.2 Account Management" vẫn ra feature "Account Management"; mã gõ "UC-01" ra "UC01" (so `idKey`).
  // Không khớp ⇒ so khoá lỏng (FLF-252) nếu chỉ một phần tử khớp: "Landing Page (Dark)" ~ "Landing Page", "Sign In" ~ "Sign In Screen"
  const resolver = (entity: string, pool: { id: string; name?: string }[]) => {
    const ids = new Set(pool.map((p) => p.id))
    const byName = new Map(pool.filter((p) => p.name && nameKey(p.name)).map((p) => [nameKey(p.name!), p.id]))
    const byLoose = uniqueIndex(pool, (p) => (p.name ? looseKey(p.name) : ""))
    // Mã so lỏng (FLF-252): quan hệ ghi "E-12" vẫn ra phần tử "E12" (id cấp tự động không cùng dạng mã tài liệu).
    // Tên khác quy ước đặt tên: quan hệ ERD ghi "PrAnalysis" ra thực thể "pr_analyses" của bảng
    const byIdKey = uniqueIndex(pool, (p) => idKey(p.id))
    const byCompact = uniqueIndex(pool, (p) => (p.name ? compactKey(p.name) : ""))
    return (ref: unknown): string | null => {
      const s = str(ref)
      if (!s) return null
      if (ids.has(s)) return s
      return byIdKey.get(idKey(s)) ?? byName.get(nameKey(s)) ?? byLoose.get(looseKey(s)) ?? byCompact.get(compactKey(s)) ?? null
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
  const entityPool = pool("entities", spine.entities)
  const resolveEntity = resolver("entities", entityPool)
  const resolveRule = resolver("business_rules", pool("business_rules", spine.business_rules as { id: string }[]))
  const resolveFunction = resolver("functions", pool("functions", spine.functions))
  const resolveNfr = resolver("nfrs", pool("nfrs", spine.nfrs as { id: string }[]))
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
  for (const field of ["vision", "type", "domain", "complexity", "stakes"] as const) {
    if (project[field] !== undefined && str(project[field])) ops.push({ op: "set", path: `project.${field}`, value: str(project[field]) })
  }
  // form_factor là mảng nền tảng (FLF-237): tài liệu ghi một chuỗi hay danh sách đều thành mảng
  if (project.form_factor !== undefined && strList(project.form_factor).length) ops.push({ op: "set", path: "project.form_factor", value: strList(project.form_factor) })
  if (project.goals !== undefined && strList(project.goals).length) ops.push({ op: "set", path: "project.goals", value: strList(project.goals) })
  // FLF-252: tên hệ thống + phạm vi release tài liệu ghi (mục Scope / In scope / Out of scope)
  if (str(project.system_name)) ops.push({ op: "set", path: "project.system_name", value: str(project.system_name) })
  const scope = project.release_scope && typeof project.release_scope === "object" ? (project.release_scope as Record<string, unknown>) : null
  if (scope && (strList(scope.in).length || strList(scope.out).length)) {
    ops.push({ op: "set", path: "project.release_scope", value: { in: strList(scope.in), out: strList(scope.out) } })
  }

  // features (+ tính năng bảng ghi mà mục 3 không có heading, + "General" cho màn/function không ghi tính năng)
  const features = of("features").filter(skip(spine.features))
  let order = spine.features.length
  for (const f of features) add("features", { id: f.id, name: str(f.value.name) || f.id, order: order++ })
  const newFeature = (name: string): string => {
    const id = alloc.next("features")
    add("features", { id, name, order: order++ })
    return id
  }
  // Cột Feature ghi gọn / dài hơn tên một heading ("Reporting" ⊂ "Reporting & Monitoring") ⇒ heading đó, khi chỉ một heading
  // khớp đủ chữ
  const words = (s: string): string[] => looseKey(s).split(" ").filter(Boolean)
  const featureByWords = (ref: string): string | null => {
    const want = words(ref)
    const hits = featurePool.filter((f) => {
      const have = f.name ? words(f.name) : []
      return want.length > 0 && have.length > 0 && (want.every((w) => have.includes(w)) || have.every((w) => want.includes(w)))
    })
    return hits.length === 1 ? hits[0].id : null
  }
  const fromTable = new Map<string, string>()
  let general: string | null = null
  const featureOr = (ref: unknown): string => {
    const name = str(ref)
    const hit = resolveFeature(ref) ?? (name ? featureByWords(name) : null)
    if (hit) return hit
    // Không ghi tính năng / chỉ là mã không phân giải được ("F-09") ⇒ "General"
    if (!name || CODE_LIKE.test(name)) return (general ??= newFeature("General"))
    // Bảng màn / bảng chức năng ghi tính năng mà mục 3 không có heading (Dashboard, Billing & Subscription…) ⇒ tính năng
    // theo đúng tên đó (FLF-252) — trước đây gom hết vào "General", mất tên tài liệu ghi
    const key = looseKey(name)
    let id = fromTable.get(key)
    if (!id) {
      id = newFeature(name)
      fromTable.set(key, id)
    }
    return id
  }

  // FLF-390: actor cha (generalization vẽ trên sơ đồ use case / "inherits everything a Guest can do" trong bảng 2.1) và
  // luồng dữ liệu vào / ra của sơ đồ ngữ cảnh — trước đây bỏ ⇒ hình ngữ cảnh chỉ còn nhãn dự phòng một chiều, use case nối
  // cả cha lẫn con. Cha chỉ người ↔ người, không tự trỏ chính nó (vòng do `actorParents` chặn lúc vẽ).
  const actorKind = new Map<string, string>([
    ...spine.actors.map((a) => [a.id, a.kind] as [string, string]),
    ...of("actors").map((a) => [a.id!, oneOf(a.value.kind, ["human", "system", "time"], "human")] as [string, string])
  ])
  // Mô tả ghi "Inherits everything a Guest can do" / "kế thừa Khách" ⇒ cha là actor người DUY NHẤT được nhắc tên sau từ đó
  const actorNames = [...spine.actors.map((a) => ({ id: a.id, name: a.name })), ...of("actors").map((a) => ({ id: a.id!, name: str(a.value.name) }))]
  const inheritedFrom = (selfId: string, description: string): string | null => {
    const m = INHERITS.exec(description)
    if (!m) return null
    const rest = description.slice(m.index)
    const tail = ` ${foldText(rest.split(/[.;](?:\s|$)/)[0])} `
    const hits = actorNames.filter((x) => x.id !== selfId && actorKind.get(x.id) === "human" && x.name && tail.includes(` ${foldText(x.name)} `))
    return new Set(hits.map((x) => x.id)).size === 1 ? hits[0].id : null
  }
  for (const a of of("actors").filter(skip(spine.actors))) {
    const kind = oneOf(a.value.kind, ["human", "system", "time"], "human")
    const parentRef = str(a.value.parent_id ?? a.value.parent)
    const parent = parentRef ? resolveActor(parentRef) : inheritedFrom(a.id!, str(a.value.description))
    const parentId = parent && parent !== a.id && kind === "human" && actorKind.get(parent) === "human" ? parent : null
    const flowsIn = [...new Set(strList(a.value.flows_in))]
    const flowsOut = [...new Set(strList(a.value.flows_out))]
    add("actors", {
      id: a.id,
      name: str(a.value.name) || a.id,
      kind,
      description: str(a.value.description),
      ...(flowsIn.length ? { flows_in: flowsIn } : {}),
      ...(flowsOut.length ? { flows_out: flowsOut } : {}),
      ...(parentId ? { parent_id: parentId } : {})
    })
  }
  for (const r of of("roles").filter(skip(spine.roles))) add("roles", { id: r.id, name: str(r.value.name) || r.id, actor_id: resolveActor(r.value.actor_id ?? r.value.actor) })
  for (const e of of("entities").filter(skip(spine.entities))) {
    const relations: string[] = []
    const verbs: Record<string, string> = {}
    for (const ref of strList(e.value.relations)) {
      const direct = resolveEntity(ref)
      const hit = direct ? { id: direct, verb: "" } : relationPhrase(ref, entityPool)
      if (!hit || hit.id === e.id || relations.includes(hit.id)) continue
      relations.push(hit.id)
      if (hit.verb) verbs[hit.id] = hit.verb
    }
    const attributes = attributesOf(e.value.attributes)
    const featureIds = [...new Set(strList(e.value.feature_ids ?? e.value.features).flatMap((ref) => resolveFeature(ref) ?? []))]
    const lifecycle = lifecycleOf(e.id ?? "", e.value.states, e.value.transitions)
    add("entities", {
      id: e.id,
      name: str(e.value.name) || e.id,
      description: str(e.value.description),
      relations,
      ...(Object.keys(verbs).length ? { relation_verbs: verbs } : {}),
      ...(attributes.length ? { attributes } : {}),
      ...(featureIds.length ? { feature_ids: featureIds } : {}),
      ...(lifecycle.states.length ? lifecycle : {})
    })
  }
  for (const b of of("business_rules").filter(skip(spine.business_rules))) {
    add("business_rules", { id: b.id, tier: ruleTierOfSections(b.sections) ?? oneOf(b.value.tier, ["high", "detail"], "detail"), statement: str(b.value.statement ?? b.value.rule ?? b.value.description), source_validation_ids: [] })
  }
  for (const s of of("screens").filter(skip(spine.screens))) {
    add("screens", {
      id: s.id,
      feature_id: featureOr(s.value.feature_id),
      name: str(s.value.name) || s.id,
      description: str(s.value.description),
      flow_to: flowEdges(s.value.flow_to, resolveScreen, s.id ?? ""),
      is_popup: s.value.is_popup === true,
      tabs: strList(s.value.tabs),
      primary_function_id: null,
      queue_order: null,
      detail_status: "signed_off"
    })
  }
  // functions: order duy nhất trong (feature, có màn / không màn)
  const orderIn = new Map<string, number>()
  // FLF-390: luồng đọc từ sơ đồ tuần tự (function) / activity (use case) trong ảnh — chỉ ghi khi có
  const functionDiagramData = (_fnId: string, value: Record<string, unknown>) => {
    const interactions = interactionsOf(value.interactions, resolveActor)
    return interactions.length ? { interactions } : {}
  }
  const useCaseActivity = (ucId: string, value: Record<string, unknown>) => {
    const activity = activityOf(ucId, value.activity_nodes, value.activity_flows, resolveActor)
    return activity.activity_nodes.length ? activity : {}
  }
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
      priority: priority(f.value.priority),
      ...functionDiagramData(f.id!, f.value)
    })
  }
  // Tài liệu không ghi chức năng hiện thực use case ⇒ chức năng trùng hẳn tên (SRS FPT đặt tên use case và chức năng như
  // nhau, không có cột liên kết — FLF-252); hai chức năng cùng tên ⇒ không đoán
  const functionByName = uniqueIndex(pool("functions", spine.functions), (p) => (p.name ? nameKey(p.name) : ""))
  for (const u of of("use_cases").filter(skip(spine.use_cases))) {
    const name = str(u.value.name) || u.id!
    const functionIds = [...new Set(strList(u.value.function_ids).map(resolveFunction).filter((x): x is string => !!x))]
    const sameName = functionIds.length ? null : functionByName.get(nameKey(name))
    if (sameName) functionIds.push(sameName)
    add("use_cases", {
      id: u.id,
      name,
      actor_ids: [...new Set(strList(u.value.actor_ids ?? u.value.actors).map(resolveActor).filter((x): x is string => !!x))],
      function_ids: functionIds,
      description: str(u.value.description),
      includes: [...new Set(strList(u.value.includes).map(resolveUseCase).filter((x): x is string => !!x && x !== u.id))],
      extends: [...new Set(strList(u.value.extends).map(resolveUseCase).filter((x): x is string => !!x && x !== u.id))],
      ...useCaseActivity(u.id!, u.value)
    })
  }
  // FLF-375: KHÔNG tự thêm actor `User` lúc import — bản 0.1 ghi nhận nguyên trạng file (business-flow §2); thiếu actor
  // tổng quát chỉ là cờ vàng `actor_generalization_missing`. Luật `User` áp khi vẽ sơ đồ (`diagram/renderers/drawn-user.ts`).
  // Ô ghi nhiều màn ("Search Results / Product Detail") ⇒ từng màn, khi cả chuỗi không là một màn và mọi phần đều khớp màn
  const resolveScreens = (ref: unknown): string[] => {
    const one = resolveScreen(ref)
    if (one) return [one]
    const parts = str(ref).split(/\s*\/\s*/).filter(Boolean)
    if (parts.length < 2) return []
    const hits = parts.map(resolveScreen)
    return hits.every((x): x is string => !!x) ? [...new Set(hits)] : []
  }
  for (const p of of("permissions").filter(skip(spine.permissions))) {
    const ref = str(p.value.screen_id ?? p.value.screen)
    let screenIds = resolveScreens(ref)
    let action = str(p.value.action)
    // Dòng con dưới một màn (FPT: "Order Queue" rồi "    Confirm / Reject Order") không phải màn ⇒ thao tác trên màn cha
    const parent = str(p.value.parent_screen)
    if (!screenIds.length && parent && action) {
      screenIds = resolveScreens(parent)
      if (screenIds.length) action = action === "access" ? ref : `${ref}: ${action}`
    }
    const roleId = resolveRole(p.value.role_id ?? p.value.role)
    if (screenIds.length && roleId && action) {
      screenIds.forEach((screenId, i) => add("permissions", { id: i === 0 ? p.id : alloc.next("permissions"), screen_id: screenId, role_id: roleId, action }))
    } else if (action) dropped.push({ screen: ref, role: str(p.value.role_id ?? p.value.role), missing: screenIds.length ? "role" : "screen" })
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
    const functionIds = [...new Set(strList(m.value.function_ids).map(resolveFunction).filter((x): x is string => !!x))]
    add("messages", { id: m.id, code: str(m.value.code) || m.id!, text: str(m.value.text ?? m.value.message), function_ids: functionIds })
  }
  for (const o of of("other_requirements").filter(skip(spine.other_requirements))) {
    add("other_requirements", {
      id: o.id,
      kind: oneOf(o.value.kind, ["risk", "assumption", "open_question", "technical_risk"], "assumption"),
      statement: str(o.value.statement ?? o.value.description)
    })
  }
  for (const g of of("glossary").filter(skip(spine.glossary))) {
    const native = str(g.value.term_native)
    add("glossary", {
      id: g.id,
      term: str(g.value.term ?? g.value.name) || g.id,
      ...(native ? { term_native: native } : {}),
      definition: str(g.value.definition ?? g.value.description)
    })
  }
  // FLF-365: tài liệu tham khảo / ma trận kiểm chứng của mẫu IEEE 29148
  for (const r of of("references").filter(skip(spine.references ?? []))) {
    const opt = (k: string) => (str(r.value[k]) ? { [k]: str(r.value[k]) } : {})
    add("references", {
      id: r.id,
      title: str(r.value.title ?? r.value.name) || r.id,
      ...opt("owner"),
      ...opt("version"),
      ...opt("date"),
      ...opt("location"),
      kind: oneOf(r.value.kind, ["normative", "informative"], "informative")
    })
  }
  for (const v of of("verifications").filter(skip(spine.verifications ?? []))) {
    const raw = str(v.value.requirement_id)
    if (!raw) continue
    // Mã yêu cầu như trong file ⇒ id Spine (chức năng / NFR / quy tắc / use case); không ra ⇒ giữ mã, luật verification_orphan báo
    const requirement = resolveFunction(raw) ?? resolveNfr(raw) ?? resolveRule(raw) ?? resolveUseCase(raw) ?? raw
    const opt = (k: string) => (str(v.value[k]) ? { [k]: str(v.value[k]) } : {})
    add("verifications", {
      id: v.id,
      requirement_id: requirement,
      method: oneOf(v.value.method, ["test", "analysis", "inspection", "demonstration", "other"], "other"),
      ...opt("artifact"),
      ...opt("status"),
      ...opt("evidence")
    })
  }
  // FLF-390: sơ đồ triển khai — nút (cha theo tên / mã, cha trước con) và đường truyền thông ghi trên nút (`links`)
  const nodeItems = of("deployment_nodes").filter(skip(spine.deployment_nodes ?? []))
  if (nodeItems.length) {
    const resolveNode = resolver("deployment_nodes", pool("deployment_nodes", spine.deployment_nodes ?? []))
    const parentOf = new Map(nodeItems.map((n) => [n.id!, ((): string | null => {
      const ref = str(n.value.parent_id ?? n.value.parent)
      const id = ref ? resolveNode(ref) : null
      return id && id !== n.id ? id : null
    })()]))
    const depth = (id: string, seen = new Set<string>()): number => {
      const p = parentOf.get(id)
      if (!p || seen.has(p) || !parentOf.has(p)) return 0
      seen.add(id)
      return 1 + depth(p, seen)
    }
    // Vòng cha (A trong B, B trong A) ⇒ bỏ cha của nút sau
    for (const n of nodeItems) {
      const seen = new Set<string>([n.id!])
      for (let p = parentOf.get(n.id!) ?? null; p; p = parentOf.get(p) ?? null) {
        if (seen.has(p)) {
          parentOf.set(n.id!, null)
          break
        }
        seen.add(p)
      }
    }
    for (const n of [...nodeItems].sort((a, b) => depth(a.id!) - depth(b.id!))) {
      const description = str(n.value.description)
      add("deployment_nodes", {
        id: n.id,
        name: str(n.value.name) || n.id,
        kind: oneOf(n.value.kind, ["device", "execution_environment", "node"], "node"),
        parent_id: parentOf.get(n.id!) ?? null,
        artifacts: strList(n.value.artifacts),
        components: strList(n.value.components),
        ...(description ? { description } : {})
      })
    }
    const linked = new Set((spine.deployment_links ?? []).map((l) => [l.from, l.to].sort().join("|")))
    for (const n of nodeItems) {
      for (const raw of Array.isArray(n.value.links) ? n.value.links : []) {
        const rec: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { to: raw }
        const to = resolveNode(str(rec.to))
        const key = to ? [n.id!, to].sort().join("|") : ""
        if (!to || to === n.id || linked.has(key)) continue
        linked.add(key)
        const protocol = str(rec.protocol ?? rec.label)
        add("deployment_links", { from: n.id, to, ...(protocol ? { protocol } : {}) })
      }
    }
  }
  // Màn chưa có function nào ⇒ placeholder: workspace không mở vòng S-5 rỗng cho nó (FLF-183, mode 1 v2)
  const screensWithFunction = new Set(ops.filter((o) => o.path === "functions[]").map((o) => (o.value as { screen_id: string | null }).screen_id))
  for (const o of ops) {
    if (o.path !== "screens[]") continue
    const screen = o.value as { id: string; detail_status: string }
    if (!screensWithFunction.has(screen.id)) screen.detail_status = "placeholder"
  }
  return ops
}

/** Feature của màn vừa được thêm trong cùng lô. */
const featureOf = (ops: Op[], screenId: string): string | null => {
  const op = ops.find((o) => o.path === "screens[]" && (o.value as { id: string }).id === screenId)
  return op ? (op.value as { feature_id: string }).feature_id : null
}
