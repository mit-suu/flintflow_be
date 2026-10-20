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
export const normalizeUseCaseBatch = (spine: Spine, ops: readonly Op[]): Op[] => {
  if (!ops.some((op) => isAdd(op, "functions") || isAdd(op, "screens") || isAdd(op, "messages"))) return [...ops]
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
  const screens: Op[] = []
  for (const op of normalized) {
    if (!isAdd(op, "screens")) continue
    const value = { ...(op.value as Element) }
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
  return [...screens, ...functions, ...useCases, ...rest, ...primarySets]
}

/** Lô có thêm use case / màn ⇒ sau khi áp phải vẽ lại sơ đồ (use case, screen flow, bố cục màn mới). */
export const addedScreenIds = (before: Pick<Spine, "screens">, after: Pick<Spine, "screens">): string[] => {
  const existed = new Set(before.screens.map((s) => s.id))
  return after.screens.filter((s) => !existed.has(s.id)).map((s) => s.id)
}

export const addsUseCaseOrScreen = (before: Pick<Spine, "screens" | "use_cases">, after: Pick<Spine, "screens" | "use_cases">): boolean =>
  after.use_cases.length > before.use_cases.length || addedScreenIds(before, after).length > 0
