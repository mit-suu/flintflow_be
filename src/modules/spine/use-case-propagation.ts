/**
 * FLF-311: thêm use case qua chat kéo theo đủ phần liên quan trong CÙNG một lô xem trước — chức năng (Functional
 * Requirements: trigger, mô tả, luồng thường/bất thường, validation), màn hình, nối vào screen flow (§3.1.1), phân quyền
 * (§3.1.3); bố cục màn (§3.1.2) và các sơ đồ vẽ lại sau khi áp. Ngoại lệ có chủ đích của luật "No auto-propagation":
 * một use case cần giao diện mà thiếu màn / chức năng thì tài liệu không nhất quán (FLF-298).
 *
 * Model soạn nội dung; code lo phần dễ sai và có luật cứng:
 * - `order` của chức năng mới (bất biến 5: duy nhất trong feature) và `feature_id` khớp màn (bất biến 6);
 * - `detail_status` của màn mới: còn vòng S-5 phía trước / đang ở S-5 ⇒ `pending` (vòng S-5 mô tả, bất biến 8), đã qua
 *   S-5 ⇒ `signed_off` vì chi tiết đã nằm trong lô author vừa xem trước và xác nhận;
 * - `primary_function_id` của màn mới trỏ chức năng đầu tiên của nó.
 */

import { PHASES } from "../pipeline/step-registry.js"
import { stepGate } from "./deterministic-check.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"

/** "thêm use case …", "bổ sung UC …", "add a use case …" — câu lệnh tạo use case mới. */
const ADD_VERB = /(thêm|bổ sung|tạo|add|create|new)/i
const USE_CASE_WORD = /(use[\s-]?case|\buc\b|ca sử dụng)/i

export const isAddUseCaseInstruction = (instruction: string): boolean => ADD_VERB.test(instruction) && USE_CASE_WORD.test(instruction)

/**
 * - `use_case_only`: chưa có màn hình (trước S-4.1) ⇒ chỉ thêm use case như trước.
 * - `screen_pending`: còn / đang ở vòng S-5 ⇒ thêm màn `pending` + chức năng (trigger, mô tả); vòng S-5 viết bố cục,
 *   luồng và validation.
 * - `full`: đã qua S-5 (hoặc đã có baseline) ⇒ lô phải mang đủ chi tiết chức năng, không ai mô tả lại sau.
 */
export type UseCaseMode = "use_case_only" | "screen_pending" | "full"

const SCREEN_LOOP_INDEX = PHASES.indexOf("S-5")

export const useCaseMode = (spine: Spine): UseCaseMode => {
  if (!stepGate(spine, false).done("S-4.1") && spine.baselines.length === 0) return "use_case_only"
  if (spine.baselines.length > 0) return "full"
  const phase = spine.progress.current_phase
  const index = phase ? PHASES.indexOf(phase as (typeof PHASES)[number]) : -1
  return index > SCREEN_LOOP_INDEX ? "full" : "screen_pending"
}

const CONTEXT_LIMIT = 60

/** S-7.3 (Application Messages) đã chạy hoặc đã có baseline ⇒ thông báo của chức năng mới phải có ngay trong lô. */
export const messagesReady = (spine: Spine): boolean => spine.baselines.length > 0 || stepGate(spine, false).done("S-7.3")

/**
 * Ngữ cảnh model cần để soạn đủ lô — gọn (id + vài field), không phải cả Spine: feature, vai trò (gắn actor), màn
 * (luồng), chức năng (để chọn thứ tự / tránh trùng tên), thông báo và quy tắc nghiệp vụ dùng lại, một chức năng mẫu đủ
 * chi tiết để bám văn phong của tài liệu.
 */
export const useCaseContext = (spine: Spine, mode: UseCaseMode): Record<string, unknown> => {
  if (mode === "use_case_only") return { mode }
  const sample = spine.functions.find((f) => f.screen_id !== null && f.normal.length > 0 && f.validations.length > 0) ?? null
  return {
    mode,
    // Kiểm trùng / chồng mục tiêu với use case có sẵn của cùng actor (luật 3e) — mô tả cắt ngắn
    use_cases: spine.use_cases.map(({ id, name, actor_ids, description }) => ({ id, name, actor_ids, description: description.slice(0, 160) })),
    features: spine.features.map(({ id, name }) => ({ id, name })),
    roles: spine.roles.map(({ id, name, actor_id }) => ({ id, name, actor_id })),
    screens: spine.screens
      .slice(0, CONTEXT_LIMIT)
      .map(({ id, name, feature_id, flow_to, is_popup }) => ({ id, name, feature_id, flow_to, is_popup })),
    functions: spine.functions.slice(0, CONTEXT_LIMIT).map(({ id, name, screen_id, feature_id }) => ({ id, name, screen_id, feature_id })),
    // FLF-311: S-7.3 đã dựng danh sách thông báo ⇒ lô phải tự thêm thông báo cho luồng bất thường mới (không còn ai làm)
    messages_ready: messagesReady(spine),
    messages: spine.messages.slice(0, CONTEXT_LIMIT).map(({ id, code, text, function_ids }) => ({ id, code, text, function_ids })),
    business_rules: spine.business_rules.slice(0, CONTEXT_LIMIT).map(({ id, statement }) => ({ id, statement })),
    ...(sample ? { sample_function: sample } : {})
  }
}

type Element = Record<string, unknown>

const isAdd = (op: Op, collection: string): boolean => op.op === "add" && op.path === `${collection}[]` && typeof op.value === "object" && op.value !== null

/** `S03` hoặc id tạm `$newScreen` ⇒ feature của màn (màn có sẵn hoặc màn thêm trong lô). */
const screenFeatures = (spine: Spine, ops: readonly Op[]): Map<string, string> => {
  const features = new Map(spine.screens.map((s) => [s.id, s.feature_id]))
  for (const op of ops) {
    if (!isAdd(op, "screens")) continue
    const value = op.value as Element
    if (typeof value.id === "string" && typeof value.feature_id === "string") features.set(value.id, value.feature_id)
  }
  return features
}

/** Field tham chiếu ⇒ collection mà id trong nó trỏ tới (đủ cho lô thêm use case). */
const REF_COLLECTION: Readonly<Record<string, string>> = {
  function_ids: "functions",
  primary_function_id: "functions",
  screen_id: "screens",
  flow_to: "screens",
  business_rule_ids: "business_rules"
}

const TEMP_ID = /^\$[A-Za-z]\w*$/

/**
 * Model thật hay DÙNG id tạm (`$newFn1` trong `function_ids`, `$newScreen` trong `permissions[].screen_id`) mà quên KHAI
 * BÁO nó làm `id` của phần tử nó thêm (e2e FLF-311) ⇒ cả lô chết vì tham chiếu chết. Id tạm được tham chiếu mà chưa ai
 * khai báo được gán, theo thứ tự xuất hiện, cho các op `add` chưa có id của đúng collection (suy từ field tham chiếu).
 * Không đoán được (thiếu phần tử chưa có id) ⇒ để nguyên, bất biến báo lỗi như cũ.
 */
export const declareTempIds = (ops: readonly Op[]): Op[] => {
  const declared = new Set<string>()
  for (const op of ops) {
    const id = op.op === "add" && typeof op.value === "object" && op.value !== null ? (op.value as Element).id : undefined
    if (typeof id === "string" && TEMP_ID.test(id)) declared.add(id)
  }
  const wanted = new Map<string, string[]>()
  const want = (collection: string, id: string) => {
    if (declared.has(id) || [...wanted.values()].some((list) => list.includes(id))) return
    wanted.set(collection, [...(wanted.get(collection) ?? []), id])
  }
  for (const op of ops) {
    // `screens[id=…].flow_to` lẫn `…flow_to[]` / `…flow_to[=$x]` (model thêm từng cạnh — gặp khi chạy AI thật)
    const field = /\.(\w+)(?:\[[^\]]*\])?$/.exec(op.path)?.[1]
    for (const ref of op.path.matchAll(/\[=(\$[A-Za-z]\w*)\]/g)) if (field && REF_COLLECTION[field]) want(REF_COLLECTION[field], ref[1])
    if (field && REF_COLLECTION[field]) for (const v of [op.value].flat()) if (typeof v === "string" && TEMP_ID.test(v)) want(REF_COLLECTION[field], v)
    if (typeof op.value !== "object" || op.value === null || Array.isArray(op.value)) continue
    for (const [key, v] of Object.entries(op.value as Element)) {
      const collection = REF_COLLECTION[key]
      if (!collection) continue
      for (const item of [v].flat()) if (typeof item === "string" && TEMP_ID.test(item)) want(collection, item)
    }
  }
  if (wanted.size === 0) return [...ops]
  return ops.map((op) => {
    const collection = /^(\w+)\[\]$/.exec(op.path)?.[1]
    const queue = collection ? wanted.get(collection) : undefined
    if (op.op !== "add" || !queue?.length || typeof op.value !== "object" || op.value === null) return op
    const value = op.value as Element
    if (value.id !== undefined) return op
    return { ...op, value: { ...value, id: queue.shift() } }
  })
}

/** `E-AUTH-003` ⇒ `E-AUTH`; mã không theo `<AREA>-<NNN>` ⇒ `null`. */
const codeArea = (code: string): string | null => /^(.+)-\d+$/.exec(code)?.[1] ?? null

/**
 * Mã thông báo theo luật S-7.3 (`appendix-content`): `<AREA>-<NNN>`, duy nhất toàn dự án, số kế tiếp trong vùng. Model
 * chọn vùng hợp nghĩa (`code` nó gửi); code chỉ lo số không trùng. Model không gửi vùng ⇒ vùng hay gặp nhất trong các
 * thông báo cùng feature (giữ kiểu mã dự án đang dùng, vd `E-AUTH`), feature chưa có ⇒ chữ đầu tên feature.
 */
const withMessageCode = (spine: Spine, value: Element, featureOfFunction: ReadonlyMap<string, string>, used: Set<string>): Element => {
  const given = typeof value.code === "string" ? value.code.trim().toUpperCase() : ""
  if (given && codeArea(given) && !used.has(given)) {
    used.add(given)
    return { ...value, code: given }
  }
  const fnIds = Array.isArray(value.function_ids) ? (value.function_ids as unknown[]).map(String) : []
  const featureId = fnIds.map((id) => featureOfFunction.get(id)).find(Boolean)
  const areaCount = new Map<string, number>()
  for (const m of spine.messages) {
    const a = codeArea(m.code)
    if (a && m.function_ids.some((id) => featureOfFunction.get(id) === featureId)) areaCount.set(a, (areaCount.get(a) ?? 0) + 1)
  }
  const common = [...areaCount.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  const featureName = spine.features.find((f) => f.id === featureId)?.name ?? ""
  const area = codeArea(given) ?? common ?? (featureName.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() || "APP")
  let n = 1
  for (const code of used) if (codeArea(code) === area) n = Math.max(n, Number(/-(\d+)$/.exec(code)?.[1] ?? 0) + 1)
  const code = `${area}-${String(n).padStart(3, "0")}`
  used.add(code)
  return { ...value, code }
}

/**
 * Chuẩn hoá lô op do MODEL soạn cho lệnh thêm use case. Không thêm/bớt op, chỉ điền/sửa field của op `add` vào
 * `functions[]` / `screens[]` theo luật cứng ở đầu file. Lô không thêm chức năng / màn nào ⇒ trả nguyên.
 */
export const normalizeUseCaseBatch = (spine: Spine, input: readonly Op[]): Op[] => {
  if (!input.some((op) => isAdd(op, "functions") || isAdd(op, "screens") || isAdd(op, "messages"))) return [...input]
  const ops = declareTempIds(input)
  const featureOfScreen = screenFeatures(spine, ops)
  const usedCodes = new Set(spine.messages.map((m) => m.code))
  const pastScreenLoop = useCaseMode(spine) === "full"

  // Thứ tự kế tiếp theo nhóm (feature, có màn / nền) — bất biến 5
  const nextOrder = new Map<string, number>()
  for (const f of spine.functions) {
    const group = `${f.feature_id}|${f.screen_id === null ? "nonscreen" : "screen"}`
    nextOrder.set(group, Math.max(nextOrder.get(group) ?? 0, f.order + 1))
  }

  const featureOfFunction = new Map(spine.functions.map((f) => [f.id, f.feature_id]))
  const firstFunctionOf = new Map<string, string>()
  /** Validation lồng trong chức năng mới: id `<function id>-V<n>` chỉ cấp được khi đã có id thật ⇒ tách thành op riêng. */
  const validationAdds = new Map<string, Op[]>()
  let autoId = 0
  const normalized = ops.map((op): Op => {
    if (!isAdd(op, "functions")) return op
    const value = { ...(op.value as Element) }
    if (typeof value.id !== "string") value.id = `$newFnAuto${++autoId}`
    const fnId = value.id as string
    if (Array.isArray(value.validations) && value.validations.some((v) => typeof (v as Element)?.id !== "string")) {
      validationAdds.set(
        fnId,
        (value.validations as Element[]).map(({ id: _id, ...rest }) => ({ op: "add" as const, path: `functions[id=${fnId}].validations[]`, value: rest }))
      )
      value.validations = []
    }
    const screenId = typeof value.screen_id === "string" ? value.screen_id : null
    // Bất biến 6: chức năng của màn mang feature của màn
    if (screenId && featureOfScreen.has(screenId)) value.feature_id = featureOfScreen.get(screenId)
    const group = `${String(value.feature_id)}|${screenId === null ? "nonscreen" : "screen"}`
    value.order = nextOrder.get(group) ?? 0
    nextOrder.set(group, (value.order as number) + 1)
    if (screenId && typeof value.id === "string" && !firstFunctionOf.has(screenId)) firstFunctionOf.set(screenId, value.id)
    featureOfFunction.set(fnId, String(value.feature_id))
    return { ...op, value }
  }).map((op): Op => (isAdd(op, "messages") ? { ...op, value: withMessageCode(spine, op.value as Element, featureOfFunction, usedCodes) } : op))

  // Id tạm chỉ được thay ở op ĐỨNG SAU op tạo ra nó (id-allocator) ⇒ sắp lô theo phụ thuộc: màn → chức năng → use case →
  // phần còn lại (luồng, phân quyền). Màn ↔ chức năng trỏ nhau ⇒ `primary_function_id` của màn mới thành op `set` cuối lô.
  const primarySets: Op[] = []
  // Màn mới trỏ tới màn mới khác (bước sau, popup xác nhận): cạnh đó thành op `set …flow_to` cuối lô — màn đích chưa
  // được tạo lúc op `add` của màn nguồn chạy (gặp khi chạy AI thật: "flow_to[=$newPopup]" chết)
  const newScreenIds = new Set(
    normalized.filter((op) => isAdd(op, "screens")).map((op) => (op.value as Element).id).filter((id): id is string => typeof id === "string" && TEMP_ID.test(id))
  )
  const flowSets: Op[] = []
  const screens: Op[] = []
  for (const op of normalized) {
    if (!isAdd(op, "screens")) continue
    const value = { ...(op.value as Element) }
    const flow = Array.isArray(value.flow_to) ? (value.flow_to as unknown[]).map(String) : []
    if (typeof value.id === "string" && flow.some((t) => newScreenIds.has(t))) {
      value.flow_to = flow.filter((t) => !newScreenIds.has(t))
      flowSets.push({ op: "set", path: `screens[id=${value.id}].flow_to`, value: flow })
    }
    value.detail_status = pastScreenLoop ? "signed_off" : "pending"
    if (value.is_popup === undefined) value.is_popup = false
    if (value.queue_order === undefined) value.queue_order = null
    const screenId = typeof value.id === "string" ? value.id : null
    const primary = typeof value.primary_function_id === "string" ? value.primary_function_id : screenId ? firstFunctionOf.get(screenId) : undefined
    value.primary_function_id = null
    if (screenId && primary) primarySets.push({ op: "set", path: `screens[id=${screenId}].primary_function_id`, value: primary })
    screens.push({ ...op, value })
  }
  const functions = normalized.filter((op) => isAdd(op, "functions")).flatMap((op) => [op, ...(validationAdds.get(String((op.value as Element).id)) ?? [])])
  const useCases = normalized.filter((op) => isAdd(op, "use_cases"))
  const rest = normalized.filter((op) => !isAdd(op, "screens") && !isAdd(op, "functions") && !isAdd(op, "use_cases"))
  return [...screens, ...functions, ...useCases, ...rest, ...flowSets, ...primarySets]
}

/** Lô có thêm use case / màn ⇒ sau khi áp phải vẽ lại sơ đồ (use case, screen flow, bố cục màn mới). */
export const addedScreenIds = (before: Pick<Spine, "screens">, after: Pick<Spine, "screens">): string[] => {
  const existed = new Set(before.screens.map((s) => s.id))
  return after.screens.filter((s) => !existed.has(s.id)).map((s) => s.id)
}

export const addsUseCaseOrScreen = (before: Pick<Spine, "screens" | "use_cases">, after: Pick<Spine, "screens" | "use_cases">): boolean =>
  after.use_cases.length > before.use_cases.length || addedScreenIds(before, after).length > 0

// ─── mỗi use case mới có giao diện: màn của nó, có luồng vào, có quyền ─────────────────────

type ScreenParts = Pick<Spine, "use_cases" | "functions" | "screens" | "actors" | "roles" | "permissions">

export type UseCaseScreenIssue =
  | { kind: "no_screen"; use_case: string; name: string }
  | { kind: "shared_new_screen"; use_case: string; name: string; other: string; screen: string }
  | { kind: "no_edge"; use_case: string; screen: string }
  | { kind: "no_view"; use_case: string; role: string }
  | { kind: "not_chained"; use_case: string; name: string; screens: string[] }
  | { kind: "no_use_case" }
  | { kind: "not_in_actor_flow"; use_case: string; screen: string; from: string[] }

/**
 * Use case mới của actor người dùng (chế độ có màn) mà thiếu phần giao diện — để §3.1.1 có luồng, §3.1.2 có bố cục và
 * §3.1.3 có quyền cho use case đó. Kiểu giao diện (màn riêng, popup, màn có sẵn, dùng chung) là lựa chọn của người dùng;
 * ở đây chỉ bắt chỗ THIẾU:
 * - không chức năng nào thuộc màn ⇒ thiếu màn;
 * - hai use case mới cùng một màn MỚI mà người dùng không chọn dùng chung (`allowShared`) ⇒ nhắc tách màn (màn có sẵn
 *   dùng chung luôn được — phần thêm chỉ đọc, luật 3e);
 * - màn mới không màn nào mở tới (`flow_to`) ⇒ không có trong screen flow;
 * - vai trò của actor không có quyền `view` trên màn của use case ⇒ thiếu dòng §3.1.3.
 */
export const newUseCaseScreenIssues = (
  before: Pick<Spine, "use_cases" | "screens">,
  after: ScreenParts,
  options: { allowShared?: boolean; expectUseCase?: boolean } = {}
): UseCaseScreenIssue[] => {
  const existedUc = new Set(before.use_cases.map((u) => u.id))
  const existedScreen = new Set(before.screens.map((s) => s.id))
  const human = new Set(after.actors.filter((a) => a.kind === "human").map((a) => a.id))
  const screenOf = new Map(after.functions.map((f) => [f.id, f.screen_id]))
  const nameOf = new Map(after.screens.map((s) => [s.id, s.name]))
  const reachable = new Set(after.screens.flatMap((s) => s.flow_to))
  const issues: UseCaseScreenIssue[] = []
  // Lệnh thêm use case mà lô chỉ có màn / chức năng, không có use case (gặp khi chạy AI thật)
  if (options.expectUseCase && !after.use_cases.some((u) => !existedUc.has(u.id))) issues.push({ kind: "no_use_case" })
  const ownerOfNewScreen = new Map<string, string>()
  for (const uc of after.use_cases.filter((u) => !existedUc.has(u.id) && u.actor_ids.some((id) => human.has(id)))) {
    const screens = [...new Set(uc.function_ids.map((id) => screenOf.get(id)).filter((s): s is string => typeof s === "string"))]
    if (screens.length === 0) {
      issues.push({ kind: "no_screen", use_case: uc.id, name: uc.name })
      continue
    }
    for (const screenId of screens.filter((s) => !existedScreen.has(s))) {
      const other = ownerOfNewScreen.get(screenId)
      if (other && !options.allowShared) issues.push({ kind: "shared_new_screen", use_case: uc.id, name: uc.name, other, screen: nameOf.get(screenId) ?? screenId })
      if (!other) ownerOfNewScreen.set(screenId, uc.id)
      if (!reachable.has(screenId) && !other) issues.push({ kind: "no_edge", use_case: uc.id, screen: nameOf.get(screenId) ?? screenId })
    }
    // Use case nhiều bước (nhiều màn mới): các màn phải nối nhau thành chuỗi — mỗi màn trừ màn đầu có cạnh vào từ màn cùng use case
    const fresh = screens.filter((s) => !existedScreen.has(s))
    if (fresh.length > 1) {
      const linked = fresh.filter((t) => screens.some((s) => s !== t && after.screens.find((x) => x.id === s)?.flow_to.includes(t))).length
      if (linked < fresh.length - 1) issues.push({ kind: "not_chained", use_case: uc.id, name: uc.name, screens: fresh.map((s) => nameOf.get(s) ?? s) })
    }
    const roles = after.roles.filter((r) => r.actor_id !== null && uc.actor_ids.includes(r.actor_id) && human.has(r.actor_id))
    // Màn vào của use case phải mở từ màn mà vai trò của actor xem được — không thì không nằm trong screen flow của actor
    const viewable = new Set(after.permissions.filter((p) => p.action === "view" && roles.some((r) => r.id === p.role_id)).map((p) => p.screen_id))
    for (const entry of fresh) {
      const from = after.screens.filter((s) => !screens.includes(s.id) && s.flow_to.includes(entry))
      // Màn không có dòng quyền nào (Login, màn công khai) ⇒ ai cũng mở được
      const open = (id: string) => viewable.has(id) || !after.permissions.some((p) => p.screen_id === id)
      if (roles.length === 0 || from.length === 0 || from.some((s) => open(s.id))) continue
      issues.push({ kind: "not_in_actor_flow", use_case: uc.id, screen: nameOf.get(entry) ?? entry, from: from.map((s) => s.name) })
    }
    for (const role of roles) {
      if (screens.some((s) => after.permissions.some((p) => p.screen_id === s && p.role_id === role.id && p.action === "view"))) continue
      issues.push({ kind: "no_view", use_case: uc.id, role: role.name })
    }
  }
  return issues
}

/** Lỗi gửi model để soạn lại một lần (tiếng Anh, theo luật 3e). */
export const useCaseScreenProblemText = (issue: UseCaseScreenIssue): string => {
  switch (issue.kind) {
    case "no_screen":
      return `New use case ${issue.use_case} "${issue.name}" has no screen: put its function on a screen or popup the user chose (own, popup, existing or shared), with an edge into it (rule 3e).`
    case "shared_new_screen":
      return `New use cases ${issue.other} and ${issue.use_case} "${issue.name}" share the new screen "${issue.screen}" but the user did not ask to share: give each its own screen or popup, edge and permission rows, unless the user chose one shared screen (rule 3e).`
    case "no_edge":
      return `New screen "${issue.screen}" of ${issue.use_case} has no edge into it: set flow_to on the screen that opens it (rule 3e).`
    case "no_view":
      return `Role "${issue.role}" of ${issue.use_case} has no view permission on its screen: add a permissions[] row (rule 3e).`
    case "not_in_actor_flow":
      return `New screen "${issue.screen}" of ${issue.use_case} opens only from ${issue.from.map((n) => `"${n}"`).join(", ")}, which its actor's role cannot view: open it from a screen in that actor's flow (rule 3e).`
    case "no_use_case":
      return "The request adds a use case but the batch has no `add use_cases[]`: add it (actor_ids, function_ids, description) with its parts (rule 3e)."
    case "not_chained":
      return `The ${issue.screens.length} new screens of ${issue.use_case} "${issue.name}" (${issue.screens.map((n) => `"${n}"`).join(", ")}) are steps of one use case: chain them in order with flow_to (rule 3e).`
  }
}

/** Còn sót sau lượt soạn lại ⇒ ghi chú trên bản xem trước để người dùng quyết định, không chặn lượt áp. */
export const useCaseScreenNote = (issues: readonly UseCaseScreenIssue[], language: "vi" | "en" = "vi"): string | null => {
  if (issues.length === 0) return null
  const line = (issue: UseCaseScreenIssue): string => {
    switch (issue.kind) {
      case "no_screen":
        return language === "en"
          ? `Use case "${issue.name}" has no screen yet, so it is missing from the screens flow (§3.1.1) and screen layouts (§3.1.2).`
          : `Use case "${issue.name}" chưa có màn hình nên chưa có trong screen flow (§3.1.1) và bố cục màn (§3.1.2).`
      case "shared_new_screen":
        return language === "en"
          ? `Use cases ${issue.other} and "${issue.name}" share the screen "${issue.screen}". Say "separate screens" if each should have its own.`
          : `Use case ${issue.other} và "${issue.name}" đang dùng chung màn "${issue.screen}". Nhắn "tách màn riêng" nếu muốn mỗi use case một màn.`
      case "no_edge":
        return language === "en"
          ? `Screen "${issue.screen}" has no screen leading to it, so it is not reachable in the screens flow.`
          : `Màn "${issue.screen}" chưa có màn nào mở tới nên chưa nằm trong luồng màn hình.`
      case "no_view":
        return language === "en"
          ? `Role "${issue.role}" has no view permission on the screen of ${issue.use_case} (§3.1.3).`
          : `Vai trò "${issue.role}" chưa có quyền xem trên màn của ${issue.use_case} (§3.1.3).`
      case "not_in_actor_flow":
        return language === "en"
          ? `Screen "${issue.screen}" opens only from ${issue.from.join(", ")}, which the actor of ${issue.use_case} cannot open.`
          : `Màn "${issue.screen}" chỉ mở từ ${issue.from.join(", ")} — màn mà actor của ${issue.use_case} không xem được, nên chưa có trong luồng của actor đó.`
      case "no_use_case":
        return language === "en"
          ? "The preview adds screens and functions but no use case — ask again or add the use case."
          : "Bản xem trước chỉ có màn và chức năng, chưa có use case nào — hãy nhắn lại để thêm use case."
      case "not_chained":
        return language === "en"
          ? `The screens of "${issue.name}" (${issue.screens.join(", ")}) are not linked in order in the screens flow.`
          : `Các màn của "${issue.name}" (${issue.screens.join(", ")}) chưa nối nhau theo thứ tự trong luồng màn hình.`
    }
  }
  return issues.map(line).join("\n")
}

// ─── trùng / chồng mục tiêu với use case có sẵn ─────────────────────

/** Động từ cùng nhóm nghĩa ⇒ hai use case cùng đối tượng là cùng một việc (Suspend Account ~ Deactivate Record). */
const VERB_GROUPS: readonly (readonly string[])[] = [
  ["deactivate", "suspend", "disable", "lock", "block", "ban", "freeze", "revoke", "deny", "archive"],
  ["activate", "reactivate", "unlock", "unblock", "unban", "restore", "enable"],
  ["create", "add", "register", "record", "submit", "enroll", "open"],
  ["update", "edit", "modify", "change", "correct", "adjust"],
  ["delete", "remove", "cancel", "withdraw", "drop", "close"],
  ["view", "review", "browse", "list", "see", "check", "search", "track", "monitor"],
  ["export", "download", "print", "share", "send"],
  ["approve", "accept", "confirm", "sign", "decide"],
  ["reject", "decline", "refuse"],
  ["assign", "allocate", "schedule", "set"]
]
const groupOf = (verb: string): number => VERB_GROUPS.findIndex((g) => g.includes(verb))
/** Từ không mang đối tượng ("Student Record" và "Student Account" cùng là sinh viên). */
const NOISE = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "and", "by", "with", "from", "record", "records", "account", "accounts", "information", "info", "details", "data", "list"])
const singular = (w: string): string => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)
const words = (name: string): string[] => name.toLowerCase().split(/[^a-z]+/).filter(Boolean)

interface ParsedUseCase {
  verbGroup: number
  objects: Set<string>
}

const parse = (name: string): ParsedUseCase => {
  const [verb = "", ...rest] = words(name)
  return { verbGroup: groupOf(verb), objects: new Set(rest.map(singular).filter((w) => !NOISE.has(w))) }
}

export interface UseCaseOverlap {
  use_case: { id: string; name: string }
  existing: { id: string; name: string }
  shared: string[]
}

/**
 * Use case mới trong lô chồng mục tiêu với use case có sẵn của cùng actor: động từ cùng nhóm nghĩa và chung ít nhất một
 * từ đối tượng, hoặc trùng tên. Lưới an toàn sau luật 3e (model phải hỏi trước) — chỉ cảnh báo, không chặn.
 */
export const useCaseOverlaps = (before: Pick<Spine, "use_cases">, after: Pick<Spine, "use_cases">): UseCaseOverlap[] => {
  const existed = new Set(before.use_cases.map((u) => u.id))
  const out: UseCaseOverlap[] = []
  for (const added of after.use_cases.filter((u) => !existed.has(u.id))) {
    const a = parse(added.name)
    for (const old of before.use_cases) {
      if (!old.actor_ids.some((id) => added.actor_ids.includes(id))) continue
      const b = parse(old.name)
      const shared = [...a.objects].filter((w) => b.objects.has(w))
      const sameName = words(added.name).join(" ") === words(old.name).join(" ")
      if (sameName || (a.verbGroup >= 0 && a.verbGroup === b.verbGroup && shared.length > 0)) {
        out.push({ use_case: { id: added.id, name: added.name }, existing: { id: old.id, name: old.name }, shared })
      }
    }
  }
  return out
}

export const useCaseOverlapNote = (overlaps: readonly UseCaseOverlap[], language: "vi" | "en" = "vi"): string | null => {
  if (overlaps.length === 0) return null
  return overlaps
    .map((o) =>
      language === "en"
        ? `New use case "${o.use_case.name}" may overlap with ${o.existing.id} "${o.existing.name}" (same actor, same goal). Check whether to merge them or say how they differ.`
        : `Use case mới "${o.use_case.name}" có thể trùng mục tiêu với ${o.existing.id} "${o.existing.name}" (cùng actor, cùng việc). Xem lại: gộp vào use case cũ, hay nói rõ hai use case khác nhau ở đâu.`
    )
    .join("\n")
}

// ─── màn hình riêng hay popup — người dùng chọn ─────────────────────

export type ScreenKind = "screen" | "popup"

const POPUP_WORDS = /(pop[\s-]?up|hộp thoại|dialog|modal)/i
const SCREEN_WORDS = /(màn hình riêng|màn riêng|trang riêng|màn hình mới|trang mới|separate screen|full screen|new screen|own screen|new page)/i
const SHARED_WORDS = /(dùng chung|chung một màn|chung 1 màn|cùng một màn|cùng 1 màn|một màn hình chung|share[sd]? (one|a|the same) screen|same screen|one shared screen)/i

const userTexts = (instruction: string, history: string): string[] => [
  ...history.split("\n").filter((l) => l.startsWith("User:")).map((l) => l.slice(5)),
  instruction
]

/**
 * Lựa chọn màn riêng / popup trong lời USER (câu lệnh + các tin `User:` của đoạn hội thoại) — lời AI không tính, vì câu
 * hỏi của AI nhắc cả hai. Nhắc sau cùng thắng ("popup… à không, màn hình riêng"). Một câu chọn khác nhau cho từng use
 * case ("Request màn riêng, Decide popup") ⇒ `null`: model đã soạn theo câu đó, code không ép một kiểu cho cả lô.
 */
export const screenKindChoice = (instruction: string, history = ""): ScreenKind | null => {
  let choice: ScreenKind | null = null
  for (const text of userTexts(instruction, history)) {
    const popup = text.search(POPUP_WORDS)
    const screen = text.search(SCREEN_WORDS)
    if (popup < 0 && screen < 0) continue
    choice = popup >= 0 && screen >= 0 && !/(à không|à mà thôi|nhầm|I mean|actually)/i.test(text) ? null : screen > popup ? "screen" : "popup"
  }
  return choice
}

/** Người dùng muốn các use case mới dùng chung một màn ("dùng chung một màn", "same screen") — không bắt tách màn. */
export const wantsSharedScreen = (instruction: string, history = ""): boolean => userTexts(instruction, history).some((t) => SHARED_WORDS.test(t))

const addedScreenOps = (ops: readonly Op[]): Element[] => ops.filter((op) => isAdd(op, "screens")).map((op) => op.value as Element)

/** Áp lựa chọn của người dùng lên màn mới của lô — code giữ đúng lời người dùng, không để model tự đổi. */
export const applyScreenKind = (ops: readonly Op[], kind: ScreenKind): Op[] =>
  ops.map((op) => (isAdd(op, "screens") ? { ...op, value: { ...(op.value as Element), is_popup: kind === "popup" } } : op))

export interface ScreenKindQuestion {
  text: string
  choices: string[]
}

/** Một use case mới của lô như câu hỏi giao diện liệt kê: yêu cầu hay model đề xuất, actor, các màn dự kiến. */
export interface BatchUseCase {
  name: string
  actors: string[]
  /** Model tự đề xuất thêm (`proposed_use_cases`) — người dùng giữ hay bỏ. */
  proposed: boolean
  /** Actor người dùng ⇒ cần giao diện; actor hệ thống / thời gian ⇒ chạy nền. */
  ui: boolean
  /** Tên các màn MỚI của use case theo thứ tự lô (luồng nhiều bước). */
  newScreens: string[]
  /** Tên các màn CÓ SẴN use case dùng. */
  existingScreens: string[]
}

/** Use case mới trong lô (op `add use_cases[]`) kèm màn của từng cái — đọc qua `function_ids` → `screen_id` (id tạm). */
export const batchUseCases = (spine: Pick<Spine, "screens" | "actors">, ops: readonly Op[], proposed: readonly string[] = []): BatchUseCase[] => {
  const human = new Set(spine.actors.filter((a) => a.kind === "human").map((a) => a.id))
  const actorName = new Map(spine.actors.map((a) => [a.id, a.name]))
  const newScreenName = new Map(addedScreenOps(ops).map((s) => [String(s.id), String(s.name ?? "")]))
  const oldScreenName = new Map(spine.screens.map((s) => [s.id, s.name]))
  const screenOfFn = new Map<string, string>()
  for (const op of ops) {
    if (!isAdd(op, "functions")) continue
    const v = op.value as Element
    if (typeof v.id === "string" && typeof v.screen_id === "string") screenOfFn.set(v.id, v.screen_id)
  }
  // Cạnh giữa các màn mới (trong `add` hoặc `set …flow_to` cuối lô) ⇒ bước sau / popup của use case dù model không đưa
  // chức năng của nó vào `function_ids`
  const nextOf = new Map<string, string[]>()
  for (const op of ops) {
    const v = op.value as Element | undefined
    const from = isAdd(op, "screens") ? (v?.id as string | undefined) : /^screens\[id=([^\]]+)\]\.flow_to$/.exec(op.path)?.[1]
    const to = isAdd(op, "screens") ? v?.flow_to : op.op === "set" ? op.value : undefined
    if (from && Array.isArray(to)) nextOf.set(from, [...(nextOf.get(from) ?? []), ...(to as unknown[]).map(String).filter((t) => newScreenName.has(t))])
  }
  const withSteps = (start: string[]): string[] => {
    const out = [...start]
    for (let i = 0; i < out.length; i++) for (const t of nextOf.get(out[i]) ?? []) if (!out.includes(t)) out.push(t)
    return out
  }
  return ops
    .filter((op) => isAdd(op, "use_cases"))
    .map((op) => op.value as Element)
    .map((u) => {
      const actors = (Array.isArray(u.actor_ids) ? (u.actor_ids as unknown[]) : []).map(String)
      const own = [...new Set((Array.isArray(u.function_ids) ? (u.function_ids as unknown[]) : []).map((f) => screenOfFn.get(String(f))).filter((s): s is string => !!s))]
      const screens = withSteps(own)
      const name = String(u.name ?? "")
      return {
        name,
        actors: actors.map((id) => actorName.get(id) ?? id),
        proposed: proposed.some((p) => sameName(p, name)),
        ui: actors.some((id) => human.has(id)),
        newScreens: screens.filter((s) => newScreenName.has(s)).map((s) => newScreenName.get(s) ?? s),
        existingScreens: screens.filter((s) => oldScreenName.has(s)).map((s) => oldScreenName.get(s) ?? s)
      }
    })
}

/**
 * Use case model ghi trong `proposed_use_cases` mà thật ra là cái người dùng xin không được coi là đề xuất — nếu không,
 * "bỏ các use case AI đề xuất" xoá mất chính yêu cầu (cả hai lỗi gặp khi chạy AI thật). Là yêu cầu khi:
 * - tên use case có trong lời người dùng;
 * - model đánh dấu MỌI use case của lô ⇒ use case đầu tiên;
 * - người dùng nhắc tên actor của nó ("…; Lecturer chấm lại…") mà actor đó chưa có use case yêu cầu nào trong lô.
 * Use case đề xuất cho chính actor đã có yêu cầu (Student xin phúc khảo ⇒ "View Review Status" của Student) vẫn là đề xuất.
 */
export const confirmedProposals = (
  spine: Pick<Spine, "actors">,
  ops: readonly Op[],
  proposed: readonly string[],
  userText: string
): string[] => {
  const norm = (s: string) => ` ${words(s).join(" ")} `
  const said = norm(userText)
  const ucs = ops.filter((op) => isAdd(op, "use_cases")).map((op) => op.value as Element)
  const nameOf = (u: Element) => String(u.name ?? "")
  const actorsOf = (u: Element) => (Array.isArray(u.actor_ids) ? (u.actor_ids as unknown[]).map(String) : [])
  let list = proposed.filter((p) => ucs.some((u) => sameName(nameOf(u), p)) && !said.includes(norm(p)))
  if (ucs.length > 0 && ucs.every((u) => list.some((p) => sameName(p, nameOf(u))))) list = list.filter((p) => !sameName(p, nameOf(ucs[0])))
  const isProposed = (u: Element) => list.some((p) => sameName(p, nameOf(u)))
  const covered = new Set(ucs.filter((u) => !isProposed(u)).flatMap(actorsOf))
  const mentioned = (actorId: string) => {
    const name = spine.actors.find((a) => a.id === actorId)?.name
    return !!name && said.includes(norm(name))
  }
  for (const u of ucs.filter(isProposed)) {
    const fresh = actorsOf(u).filter((id) => !covered.has(id) && mentioned(id))
    if (fresh.length === 0) continue
    list = list.filter((p) => !sameName(p, nameOf(u)))
    for (const id of actorsOf(u)) covered.add(id)
  }
  return list
}

/** Dòng mở đầu câu hỏi chi tiết — `askedList` tìm danh sách ngay sau dòng này. */
const DETAILED_HEADER = { vi: "Yêu cầu này thêm các use case sau:", en: "This request adds these use cases:" }
const PROPOSED_HEADER = { vi: "AI đề xuất thêm để khớp dự án (giữ hay bỏ):", en: "Proposed by AI to fit the project (keep or drop):" }

const describeItem = (u: BatchUseCase, i: number, language: "vi" | "en"): string => {
  const head = `${i + 1}. "${u.name}" (${u.actors.join(", ")})`
  if (!u.ui) return `${head} — ${language === "en" ? "runs in the background, no screen" : "chạy nền, không cần màn"}`
  const parts = [
    ...(u.newScreens.length ? [`${language === "en" ? "new screens" : "màn mới"}: ${u.newScreens.map((n) => `"${n}"`).join(" → ")}`] : []),
    ...(u.existingScreens.length ? [`${language === "en" ? "existing" : "màn có sẵn"}: ${u.existingScreens.map((n) => `"${n}"`).join(", ")}`] : [])
  ]
  return parts.length ? `${head} — ${parts.join("; ")}` : head
}

/**
 * Lô có màn mới mà người dùng chưa chọn giao diện ⇒ câu hỏi kèm lựa chọn nhanh (thẻ chọn ở FE). Lô chỉ một use case, một
 * màn ⇒ câu ngắn "màn riêng hay popup". Lô nhiều use case có giao diện, có use case model ĐỀ XUẤT thêm, hoặc một use case
 * nhiều màn (luồng nhiều bước) ⇒ câu chi tiết: liệt kê từng use case (đánh số, tách nhóm đề xuất) kèm các màn dự kiến, để
 * người dùng trả lời riêng từng số / từng màn và giữ hay bỏ use case đề xuất. Lô không thêm màn ⇒ `null`.
 */
export const screenKindQuestion = (
  spine: Pick<Spine, "screens" | "actors">,
  ops: readonly Op[],
  language: "vi" | "en" = "vi",
  proposed: readonly string[] = []
): ScreenKindQuestion | null => {
  const added = addedScreenOps(ops)
  const items = batchUseCases(spine, ops, proposed)
  if (added.length === 0 && !items.some((u) => u.proposed)) return null
  const newIds = new Set(added.map((s) => String(s.id)))
  // Màn CÓ SẴN mở màn mới (cạnh giữa hai màn mới — bước sau, popup — không tính)
  const hostId = ops
    .filter((op) => op.op === "set" && /^screens\[id=[^\]$]+\]\.flow_to$/.test(op.path) && Array.isArray(op.value))
    .find((op) => (op.value as unknown[]).some((v) => newIds.has(String(v))))
    ?.path.match(/^screens\[id=([^\]]+)\]/)?.[1]
  const host = spine.screens.find((s) => s.id === hostId)?.name
  const detailed = items.filter((u) => u.ui).length > 1 || items.some((u) => u.proposed || u.newScreens.length > 1)
  if (detailed) {
    const ordered = [...items.filter((u) => !u.proposed), ...items.filter((u) => u.proposed)]
    const requested = ordered.filter((u) => !u.proposed).map((u, i) => describeItem(u, i, language))
    const offered = ordered.filter((u) => u.proposed).map((u, i) => describeItem(u, i + requested.length, language))
    const anyProposed = offered.length > 0
    const lines = [DETAILED_HEADER[language], ...requested, ...(anyProposed ? [PROPOSED_HEADER[language], ...offered] : [])]
    if (language === "en") {
      return {
        text: `${lines.join("\n")}\nHow should each look: its own screen, a popup${host ? ` opened from "${host}"` : ""}, an existing screen, or one shared screen? Answer per number or per screen, e.g. "1 own screen, step “Confirm” is a popup; 2 and 3 share one screen${anyProposed ? "; drop 4" : ""}".`,
        choices: anyProposed
          ? ["Keep all, each its own screen", "Drop the proposed use cases", "One shared screen"]
          : ["Each use case its own screen", "One shared screen", host ? `Popups opened from ${host}` : "Popups"]
      }
    }
    return {
      text: `${lines.join("\n")}\nMỗi use case dùng giao diện nào: màn hình riêng, popup${host ? ` mở từ "${host}"` : ""}, màn có sẵn, hay dùng chung một màn? Trả lời theo số hoặc theo màn, vd. "1 màn riêng, bước “Confirm” là popup; 2 và 3 dùng chung một màn${anyProposed ? "; bỏ 4" : ""}".`,
      choices: anyProposed
        ? ["Giữ tất cả, mỗi use case màn riêng", "Bỏ các use case AI đề xuất", "Dùng chung một màn hình"]
        : ["Mỗi use case một màn hình riêng", "Dùng chung một màn hình", host ? `Popup mở từ ${host}` : "Popup"]
    }
  }
  const name = String(added[0].name ?? "")
  if (language === "en") {
    return {
      text: `"${name}" needs a UI: a separate screen, or a popup${host ? ` opened from "${host}"` : ""}? You can also add what the user enters or any rule it must follow.`,
      choices: ["Separate screen", host ? `Popup opened from ${host}` : "Popup"]
    }
  }
  return {
    text: `"${name}" cần giao diện: làm một màn hình riêng, hay một popup${host ? ` mở từ "${host}"` : ""}? Nếu cần, bạn mô tả thêm người dùng nhập gì hoặc quy tắc phải tuân theo.`,
    choices: ["Màn hình riêng", host ? `Popup mở từ ${host}` : "Popup"]
  }
}

// ─── kế hoạch giao diện theo từng use case / từng màn (lệnh sinh nhiều use case, nhiều màn) ─────────────────────

export type UiChoiceKind = "own" | "popup" | "shared" | "existing"

export interface UiPlanEntry {
  /** Số thứ tự trong câu hỏi giao diện (1-based). */
  index: number
  /** Tên use case như câu hỏi đã liệt kê. */
  name: string
  /** Model đề xuất thêm (nhóm "AI đề xuất"). */
  proposed: boolean
  /** Người dùng bỏ use case này (chỉ use case đề xuất / bất kỳ số nào người dùng nói "bỏ"). */
  drop?: boolean
  kind?: UiChoiceKind
  /** `shared`: các use case cùng nhóm dùng chung MỘT màn mới. */
  group?: number
  /** `popup` / `existing`: tên màn mở popup / màn có sẵn người dùng nêu. */
  screen?: string
  /** "gộp thành một màn": use case nhiều bước chỉ còn một màn. */
  merge?: boolean
  /** Màn (theo tên) người dùng chọn làm popup: `bước "Confirm" là popup`. */
  popupScreens?: string[]
}

export interface AskedUseCase {
  name: string
  proposed: boolean
  screens: string[]
}

/** Dòng liệt kê của câu hỏi chi tiết: `1. "Request Grade Review" (Student) — màn mới: "A" → "B"`. */
const LISTED_USE_CASE = /^\s*(\d+)\.\s*"([^"]+)"\s*\(/

/** Danh sách use case của câu hỏi giao diện chi tiết GẦN NHẤT (thứ tự = số người dùng trả lời theo). */
export const askedList = (history: string): AskedUseCase[] => {
  const lines = history.split("\n")
  const start = lines.map((l) => l.includes(DETAILED_HEADER.vi) || l.includes(DETAILED_HEADER.en)).lastIndexOf(true)
  if (start < 0) return []
  const out: AskedUseCase[] = []
  let proposed = false
  for (const line of lines.slice(start + 1)) {
    if (line.includes(PROPOSED_HEADER.vi) || line.includes(PROPOSED_HEADER.en)) {
      proposed = true
      continue
    }
    const m = LISTED_USE_CASE.exec(line)
    if (!m || Number(m[1]) !== out.length + 1) break
    const tail = line.slice(m[0].length)
    const screens = [...(/(?:màn mới|new screens):\s*([^;]+)/.exec(tail)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((s) => s[1])
    out.push({ name: m[2], proposed, screens })
  }
  return out
}

/** Đoạn hội thoại đã có câu hỏi giao diện của code (câu chi tiết hoặc câu ngắn "màn riêng hay popup") — không hỏi lại. */
export const uiAskedBefore = (history: string): boolean =>
  history.includes(DETAILED_HEADER.vi) ||
  history.includes(DETAILED_HEADER.en) ||
  history
    .split("\n")
    .filter((l) => l.startsWith("AI:"))
    .some((l) => POPUP_WORDS.test(l) && /(màn hình riêng|màn riêng|separate screen|own screen)/i.test(l))

/** Chỉ tên — giữ cho chỗ gọi cũ. */
export const askedUseCases = (history: string): string[] => askedList(history).map((u) => u.name)

const EXISTING_WORDS = /(màn (hình )?có sẵn|màn (hình )?cũ|màn hiện có|existing screen)/i
const OWN_WORDS = /(riêng|mới|own|separate|new screen)/i
// Hết từ = không còn chữ cái hai bên (`\b` của JS không nhận chữ có dấu như "ỏ")
const DROP_WORDS = /(?<!\p{L})(bỏ|không cần|không giữ|xoá|xóa|drop|remove|skip|no need)(?!\p{L})/iu
const KEEP_WORDS = /(?<!\p{L})(giữ|keep)(?!\p{L})/iu
/** Động từ đứng TRƯỚC số: "bỏ 4", "giữ 2 và 3", "drop 3". */
const VERB_FIRST = /(?<!\p{L})(bỏ|không cần|xoá|xóa|drop|remove|skip|giữ|keep)\s+((?:(?:uc|use case)\s*)?\d+(?:\s*(?:,|và|and|&|\+)\s*\d+)*)/giu
const MERGE_WORDS = /(gộp|merge|một màn duy nhất|chỉ một màn|1 màn duy nhất|single screen|one screen only)/i
/** Màn người dùng nêu: "popup mở từ Dashboard", "màn có sẵn Class List", "opened from Class List". */
const HOST = /(?:mở từ|từ màn(?: hình)?|màn(?: hình)? có sẵn|opened from|existing screen)\s+["'“]?([^,;"'”\n]+?)["'”]?\s*(?:$|[,;\n])/i
/** `bước "Confirm Request" là popup`, `màn Confirm thành popup`, `step "Confirm" is a popup`. */
const SCREEN_POPUP = /(?:bước|màn(?: hình)?|step|screen)\s+["“]?([^"”,;\n]+?)["”]?\s+(?:là|thành|làm|as|is)\s+(?:một |a )?popup/gi
/** Bỏ use case AI đề xuất (không kèm số). */
const DROP_PROPOSED = /(bỏ|không cần|drop|remove)[^,;\n]*(đề xuất|proposed)/i

const classify = (text: string): { kind: UiChoiceKind; screen?: string } | null => {
  const host = HOST.exec(`${text}\n`)?.[1]?.trim()
  if (SHARED_WORDS.test(text) || /\bchung\b/i.test(text)) return { kind: "shared" }
  if (POPUP_WORDS.test(text)) return { kind: "popup", ...(host ? { screen: host } : {}) }
  if (EXISTING_WORDS.test(text)) return { kind: "existing", ...(host ? { screen: host } : {}) }
  if (SCREEN_WORDS.test(text) || OWN_WORDS.test(text)) return { kind: "own" }
  return null
}

/** Một đoạn trả lời ⇒ phần của nó trong kế hoạch: bỏ / gộp màn / màn nào là popup / kiểu giao diện. */
const segmentChoice = (raw: string): Partial<UiPlanEntry> | null => {
  const popupScreens = [...raw.matchAll(SCREEN_POPUP)].map((m) => m[1].trim())
  const text = raw.replace(SCREEN_POPUP, " ")
  if (DROP_WORDS.test(text) && !KEEP_WORDS.test(text)) return { drop: true }
  const choice = classify(text)
  const merge = MERGE_WORDS.test(text)
  if (!choice && !merge && popupScreens.length === 0 && !KEEP_WORDS.test(text)) return null
  return { ...(choice ?? {}), ...(merge ? { merge: true } : {}), ...(popupScreens.length ? { popupScreens } : {}) }
}

/**
 * Câu trả lời cho câu hỏi giao diện ⇒ kế hoạch cho từng use case. Hiểu trả lời chung (nút chọn nhanh: "Mỗi use case một
 * màn hình riêng", "Dùng chung một màn hình", "Bỏ các use case AI đề xuất") lẫn riêng từng số / từng màn ("1 màn riêng,
 * bước \"Confirm\" là popup; 2 và 3 dùng chung; bỏ 4; 5 gộp thành 1 màn"). Số không nhắc ⇒ chỉ có mặc định (giữ, màn riêng).
 */
export const parseUiAnswer = (input: string, asked: readonly (string | AskedUseCase)[]): UiPlanEntry[] => {
  // Tên trong ngoặc kép ("Step 2", "Screen S92") có thể chứa số ⇒ che lại khi tách theo số thứ tự, mở ra khi đọc lựa chọn
  const quoted: string[] = []
  const letters = (n: number): string => (n < 26 ? String.fromCharCode(97 + n) : letters(Math.floor(n / 26) - 1) + String.fromCharCode(97 + (n % 26)))
  let answer = input.replace(/["“]([^"”]*)["”]/g, (_m, q: string) => `"§${letters(quoted.push(q) - 1)}§"`)
  const unmask = (text: string): string => text.replace(/§([a-z]+)§/g, (_m, k: string) => quoted[[...k].reduce((n, c) => n * 26 + c.charCodeAt(0) - 96, 0) - 1] ?? "")
  const items: AskedUseCase[] = asked.map((a) => (typeof a === "string" ? { name: a, proposed: false, screens: [] } : a))
  const entries = new Map<number, UiPlanEntry>(items.map((u, i) => [i + 1, { index: i + 1, name: u.name, proposed: u.proposed }]))
  const set = (index: number, part: Partial<UiPlanEntry>) => {
    const e = entries.get(index)
    if (e) entries.set(index, { ...e, ...part, popupScreens: [...(e.popupScreens ?? []), ...(part.popupScreens ?? [])] })
  }
  if (DROP_PROPOSED.test(answer)) for (const [i, u] of items.entries()) if (u.proposed) set(i + 1, { drop: true })
  // Cắt cụm "bỏ các use case AI đề xuất" khỏi câu: chữ "bỏ" trong đó không thuộc về số đứng trước ("1 màn riêng, bỏ …")
  answer = answer.replace(new RegExp(DROP_PROPOSED.source, "gi"), " ")
  // "bỏ 4", "giữ 2 và 3": áp rồi cắt khỏi câu; phần còn lại đọc theo kiểu "<số> <lựa chọn>"
  for (const m of answer.matchAll(VERB_FIRST)) {
    const drop = DROP_WORDS.test(m[1])
    for (const n of m[2].matchAll(/\d+/g)) if (Number(n[0]) >= 1 && Number(n[0]) <= items.length) set(Number(n[0]), { drop })
  }
  answer = answer.replace(VERB_FIRST, " ")
  // Số đứng sau "thành / into / còn" là số màn ("gộp thành 1 màn"), không phải số thứ tự use case
  const segments = [...answer.matchAll(/((?:(?:uc|use case)?\s*(?<!(?:thành|into|còn|thành một)\s*)\d+\s*(?:,|và|and|&|\+|\/|-)?\s*)+)([^\d]*(?:(?:thành|into|còn)\s*\d+[^\d]*)*)/gi)]
    .map((m) => ({ indices: [...m[1].matchAll(/\d+/g)].map((n) => Number(n[0])).filter((n) => n >= 1 && n <= items.length), text: m[2] }))
    .filter((s) => s.indices.length > 0)
  if (segments.length === 0) {
    const whole = segmentChoice(unmask(answer.replace(DROP_PROPOSED, " ")))
    if (whole && !whole.drop) for (const i of entries.keys()) if (!entries.get(i)?.drop) set(i, { ...whole, ...(whole.kind === "shared" ? { group: 1 } : {}) })
  }
  segments.forEach((s, g) => {
    const part = segmentChoice(unmask(s.text))
    if (part) for (const index of s.indices) set(index, { ...part, ...(part.kind === "shared" ? { group: g + 1 } : {}) })
  })
  return [...entries.values()].map((e) => (e.popupScreens?.length ? e : (({ popupScreens: _p, ...rest }) => rest)(e))).filter((e) => Object.keys(e).length > 3 || e.proposed)
}

/** Kế hoạch giao diện của lượt này: danh sách của câu hỏi chi tiết gần nhất + câu trả lời (câu lệnh hiện tại). */
export const uiPlanFor = (instruction: string, history = ""): UiPlanEntry[] => {
  const asked = askedList(history)
  return asked.length === 0 ? [] : parseUiAnswer(instruction, asked)
}

/** Kế hoạch đưa model (`use_case_context.ui_plan`) — câu ngắn tiếng Anh cho từng use case. */
export const uiPlanForModel = (plan: readonly UiPlanEntry[]): { use_case: string; ui: string }[] =>
  plan.map((e) => {
    if (e.drop) return { use_case: e.name, ui: "DROPPED by the user: do not add this use case or any of its parts" }
    const partners = plan.filter((o) => o.kind === "shared" && o.group === e.group && o.index !== e.index).map((o) => `"${o.name}"`)
    const kind = e.kind
      ? {
          own: "its own new screen(s), used by no other new use case",
          shared: `one new screen shared with ${partners.join(", ") || "no other use case"}`,
          popup: `a new popup${e.screen ? ` opened from "${e.screen}"` : ""}`,
          existing: `an existing screen${e.screen ? ` ("${e.screen}")` : ""}, no new screen`
        }[e.kind]
      : `keep it${e.proposed ? " (user accepted the proposal)" : ""}, own new screen(s)`
    const extra = [
      ...(e.merge ? ["exactly ONE screen (merge its steps)"] : []),
      ...(e.popupScreens?.length ? [`screen(s) ${e.popupScreens.map((n) => `"${n}"`).join(", ")} are popups`] : [])
    ]
    return { use_case: e.name, ui: [kind, ...extra].join("; ") }
  })

const sameName = (a: string, b: string): boolean => words(a).join(" ") === words(b).join(" ")
/** Tên màn người dùng gõ khớp tên màn trong lô: không phân biệt hoa thường / dấu câu, giữ chữ số ("Step 2"). */
const nameMatches = (screenName: string, wanted: string): boolean => {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  const a = norm(screenName)
  const b = norm(wanted)
  return a === b || (b.length > 0 && ` ${a} `.includes(` ${b} `))
}

/** Bỏ khỏi lô một use case người dùng không giữ cùng mọi phần CHỈ của nó (chức năng, màn, quyền, cạnh luồng, thông báo). */
const dropUseCases = (ops: readonly Op[], names: readonly string[]): Op[] => {
  if (names.length === 0) return [...ops]
  const ucAdds = ops.filter((op) => isAdd(op, "use_cases")).map((op) => op.value as Element)
  const fnsOf = (u: Element) => (Array.isArray(u.function_ids) ? (u.function_ids as unknown[]).map(String) : [])
  const dropped = ucAdds.filter((u) => names.some((n) => sameName(n, String(u.name ?? ""))))
  if (dropped.length === 0) return [...ops]
  const keptFns = new Set(ucAdds.filter((u) => !dropped.includes(u)).flatMap(fnsOf))
  const goneFns = new Set(dropped.flatMap(fnsOf).filter((f) => !keptFns.has(f) && TEMP_ID.test(f)))
  const fnScreen = new Map<string, string>()
  for (const op of ops) if (isAdd(op, "functions")) fnScreen.set(String((op.value as Element).id), String((op.value as Element).screen_id))
  const keptScreens = new Set([...fnScreen.entries()].filter(([f]) => keptFns.has(f)).map(([, s]) => s))
  const goneScreens = new Set([...goneFns].map((f) => fnScreen.get(f)).filter((s): s is string => !!s && TEMP_ID.test(s) && !keptScreens.has(s)))
  // Màn mới đi tiếp từ màn đã bỏ (bước sau, popup xác nhận) mà không chức năng nào của use case được giữ nằm trên đó ⇒ bỏ
  // theo, cùng chức năng không use case giữ nào nhận (model hay quên đưa chức năng của popup vào `function_ids`)
  const flowOf = new Map<string, string[]>()
  for (const op of ops) {
    const v = op.value as Element | undefined
    if (isAdd(op, "screens") && typeof v?.id === "string") flowOf.set(v.id, [...(flowOf.get(v.id) ?? []), ...((v.flow_to as string[] | undefined) ?? [])])
    const setFlow = /^screens\[id=([^\]]+)\]\.flow_to$/.exec(op.path)
    if (op.op === "set" && setFlow && Array.isArray(op.value)) flowOf.set(setFlow[1], [...(flowOf.get(setFlow[1]) ?? []), ...(op.value as string[])])
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const g of [...goneScreens]) {
      for (const t of flowOf.get(g) ?? []) {
        if (!TEMP_ID.test(t) || goneScreens.has(t) || keptScreens.has(t)) continue
        goneScreens.add(t)
        grew = true
      }
    }
    for (const [f, s] of fnScreen) if (goneScreens.has(s) && !keptFns.has(f) && !goneFns.has(f)) goneFns.add(f)
  }
  const gone = (id: unknown) => goneFns.has(String(id)) || goneScreens.has(String(id))
  return ops.flatMap((op): Op[] => {
    const v = op.value as Element | undefined
    if (isAdd(op, "use_cases") && dropped.includes(v as Element)) return []
    if ((isAdd(op, "functions") || isAdd(op, "screens")) && gone(v?.id)) return []
    if (isAdd(op, "permissions") && gone(v?.screen_id)) return []
    if (/^(functions|screens)\[id=([^\]]+)\]/.test(op.path) && gone(/^\w+\[id=([^\]]+)\]/.exec(op.path)?.[1])) return []
    if (isAdd(op, "messages") && Array.isArray(v?.function_ids)) {
      const left = (v.function_ids as unknown[]).filter((f) => !gone(f))
      return left.length ? [{ ...op, value: { ...v, function_ids: left } }] : []
    }
    if (op.op === "set" && /\.flow_to$/.test(op.path) && Array.isArray(op.value)) return [{ ...op, value: (op.value as unknown[]).filter((t) => !gone(t)) }]
    return [op]
  })
}

/**
 * Áp phần chắc chắn của kế hoạch lên lô model soạn: bỏ use case người dùng không giữ (cùng phần chỉ của nó); màn mới của
 * use case chọn popup ⇒ `is_popup: true`, chọn màn riêng / dùng chung ⇒ `false`; màn người dùng nêu tên là popup ⇒ `true`.
 */
export const applyUiPlan = (input: readonly Op[], plan: readonly UiPlanEntry[]): Op[] => {
  if (plan.length === 0) return [...input]
  const ops = dropUseCases(input, plan.filter((e) => e.drop).map((e) => e.name))
  const fnScreen = new Map<string, string>()
  for (const op of ops) {
    if (!isAdd(op, "functions")) continue
    const v = op.value as Element
    if (typeof v.id === "string" && typeof v.screen_id === "string") fnScreen.set(v.id, v.screen_id)
  }
  const popupOf = new Map<string, boolean>()
  const popupNames: string[] = []
  for (const op of ops) {
    if (!isAdd(op, "use_cases")) continue
    const v = op.value as Element
    const entry = plan.find((e) => sameName(e.name, String(v.name ?? "")))
    if (!entry) continue
    popupNames.push(...(entry.popupScreens ?? []))
    if (!entry.kind || entry.kind === "existing") continue
    for (const fn of Array.isArray(v.function_ids) ? (v.function_ids as unknown[]) : []) {
      const screen = fnScreen.get(String(fn))
      if (screen) popupOf.set(screen, entry.kind === "popup")
    }
  }
  return ops.map((op) => {
    if (!isAdd(op, "screens")) return op
    const v = op.value as Element
    const named = popupNames.some((n) => nameMatches(String(v.name ?? ""), n))
    const popup = named ? true : typeof v.id === "string" ? popupOf.get(v.id) : undefined
    return popup === undefined ? op : { ...op, value: { ...v, is_popup: popup } }
  })
}

export type UiPlanIssue =
  | { kind: "missing"; name: string }
  | { kind: "dropped_present"; name: string }
  | { kind: "not_own"; name: string; other: string }
  | { kind: "not_shared"; names: string[] }
  | { kind: "not_popup"; name: string }
  | { kind: "wrong_host"; name: string; host: string }
  | { kind: "not_existing"; name: string }
  | { kind: "not_merged"; name: string; count: number }
  | { kind: "screen_not_popup"; name: string; screen: string }

/** Lô (sau khi áp thử) lệch kế hoạch giao diện người dùng đã chọn — kiểm từng use case, từng màn. */
export const uiPlanIssues = (
  before: Pick<Spine, "use_cases" | "screens">,
  after: Pick<Spine, "use_cases" | "functions" | "screens">,
  plan: readonly UiPlanEntry[]
): UiPlanIssue[] => {
  if (plan.length === 0) return []
  const existedUc = new Set(before.use_cases.map((u) => u.id))
  const existedScreen = new Set(before.screens.map((s) => s.id))
  const added = after.use_cases.filter((u) => !existedUc.has(u.id))
  const screenOf = new Map(after.functions.map((f) => [f.id, f.screen_id]))
  const byId = new Map(after.screens.map((s) => [s.id, s]))
  const screensOf = (ucId: string): string[] => {
    const uc = added.find((u) => u.id === ucId)
    return [...new Set((uc?.function_ids ?? []).map((id) => screenOf.get(id)).filter((s): s is string => typeof s === "string"))]
  }
  const freshOf = (ucId: string): string[] => screensOf(ucId).filter((s) => !existedScreen.has(s))
  const ucOf = new Map(plan.map((e) => [e.index, added.find((u) => sameName(u.name, e.name))]))
  const issues: UiPlanIssue[] = []
  for (const e of plan) {
    const uc = ucOf.get(e.index)
    if (e.drop) {
      if (uc) issues.push({ kind: "dropped_present", name: e.name })
      continue
    }
    if (!uc) {
      issues.push({ kind: "missing", name: e.name })
      continue
    }
    const fresh = freshOf(uc.id)
    if (e.kind === "own") {
      const other = added.find((o) => o.id !== uc.id && freshOf(o.id).some((s) => fresh.includes(s)))
      if (fresh.length === 0 || other) issues.push({ kind: "not_own", name: e.name, other: other?.name ?? "" })
    } else if (e.kind === "popup") {
      const popup = fresh.find((s) => byId.get(s)?.is_popup)
      if (!popup) issues.push({ kind: "not_popup", name: e.name })
      else if (e.screen) {
        const host = after.screens.find((s) => sameName(s.name, e.screen ?? "")) ?? after.screens.find((s) => nameMatches(s.name, e.screen ?? ""))
        if (host && !host.flow_to.includes(popup)) issues.push({ kind: "wrong_host", name: e.name, host: host.name })
      }
    } else if (e.kind === "existing" && (fresh.length > 0 || screensOf(uc.id).length === 0)) {
      issues.push({ kind: "not_existing", name: e.name })
    }
    if (e.merge && fresh.length > 1) issues.push({ kind: "not_merged", name: e.name, count: fresh.length })
    for (const wanted of e.popupScreens ?? []) {
      const screen = fresh.map((s) => byId.get(s)).find((s) => s && nameMatches(s.name, wanted))
      if (screen && !screen.is_popup) issues.push({ kind: "screen_not_popup", name: e.name, screen: screen.name })
    }
  }
  const groups = new Map<number, UiPlanEntry[]>()
  for (const e of plan.filter((p) => p.kind === "shared" && !p.drop)) groups.set(e.group ?? 0, [...(groups.get(e.group ?? 0) ?? []), e])
  for (const members of groups.values()) {
    const ucs = members.map((m) => ucOf.get(m.index))
    if (members.length < 2 || ucs.some((u) => !u)) continue
    const sets = ucs.map((u) => freshOf(u!.id))
    if (!sets[0].some((s) => sets.every((set) => set.includes(s)))) issues.push({ kind: "not_shared", names: members.map((m) => m.name) })
  }
  return issues
}

/** Lỗi gửi model để soạn lại theo đúng lựa chọn của người dùng (tiếng Anh). */
export const uiPlanProblemText = (issue: UiPlanIssue): string => {
  switch (issue.kind) {
    case "missing":
      return `The user kept use case "${issue.name}" but the batch does not add it: add it with its parts (rule 3e).`
    case "dropped_present":
      return `The user dropped use case "${issue.name}": remove it and every part only it uses (function, screen, permissions, flow edges).`
    case "not_own":
      return issue.other
        ? `Use case "${issue.name}" must have its own new screen (user's choice), but it shares one with "${issue.other}".`
        : `Use case "${issue.name}" must have its own new screen (user's choice), but it has none.`
    case "not_shared":
      return `Use cases ${issue.names.map((n) => `"${n}"`).join(", ")} must share ONE new screen (user's choice): put their functions on the same new screen.`
    case "not_popup":
      return `Use case "${issue.name}" must use a new popup (user's choice): add a screen with "is_popup": true for its function.`
    case "wrong_host":
      return `The popup of "${issue.name}" must open from "${issue.host}" (user's choice): add it to that screen's flow_to.`
    case "not_existing":
      return `Use case "${issue.name}" must use an existing screen (user's choice): put its function on that screen and add no new screen for it.`
    case "not_merged":
      return `Use case "${issue.name}" must have exactly ONE screen (user's choice), but it has ${issue.count}: merge its steps into one screen.`
    case "screen_not_popup":
      return `Screen "${issue.screen}" of "${issue.name}" must be a popup (user's choice): set "is_popup": true.`
  }
}

/** Còn lệch sau lượt soạn lại ⇒ ghi chú trên bản xem trước, người dùng quyết định. */
export const uiPlanNote = (issues: readonly UiPlanIssue[], language: "vi" | "en" = "vi"): string | null => {
  if (issues.length === 0) return null
  if (language === "en") return issues.map(uiPlanProblemText).join("\n")
  const vi = (issue: UiPlanIssue): string => {
    switch (issue.kind) {
      case "missing":
        return `Bản xem trước chưa có use case "${issue.name}" mà bạn đã giữ.`
      case "dropped_present":
        return `Use case "${issue.name}" bạn đã bỏ vẫn còn trong bản xem trước.`
      case "not_own":
        return issue.other ? `"${issue.name}" chưa có màn riêng (đang dùng chung với "${issue.other}").` : `"${issue.name}" chưa có màn riêng.`
      case "not_shared":
        return `${issue.names.map((n) => `"${n}"`).join(", ")} chưa dùng chung một màn như bạn chọn.`
      case "not_popup":
        return `"${issue.name}" chưa phải popup như bạn chọn.`
      case "wrong_host":
        return `Popup của "${issue.name}" chưa mở từ màn "${issue.host}".`
      case "not_existing":
        return `"${issue.name}" đang có màn mới thay vì dùng màn có sẵn như bạn chọn.`
      case "not_merged":
        return `"${issue.name}" vẫn có ${issue.count} màn, chưa gộp thành một màn như bạn chọn.`
      case "screen_not_popup":
        return `Màn "${issue.screen}" của "${issue.name}" chưa phải popup như bạn chọn.`
    }
  }
  return issues.map(vi).join("\n")
}
