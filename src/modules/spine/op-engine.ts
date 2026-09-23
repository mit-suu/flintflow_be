/**
 * op-engine.ts
 * ─────────────────────────────────────────────────────────────────
 * Op-based write (Phases §2.1, srs-spine.md §3, §6): AI/user phát op, code áp.
 *
 * Một transaction:
 *   1. kiểm `base_version === spine_version` (lệch ⇒ 409 SPINE_VERSION_CONFLICT)
 *   2. deep clone, áp op tuần tự, ghi `before` cho từng thay đổi
 *   3. mở rộng cascade tới điểm bất động (+ renumber feature, append screen_queue)
 *   4. kiểm 8 bất biến + `spineSchema` ở CUỐI lô ⇒ vi phạm thì từ chối cả lô
 *   5. `spine_version++` đúng một lần, ghi `changes[]` seq liên tục (repository.applyAndSave)
 *
 * Mã hoá `changes[]` để revert khôi phục deep-equal: xem `ABSENT` trong op.types.ts.
 * Mọi thay đổi ghi path chuẩn hoá `[id=...]`, nên revert không lệ thuộc khoá tự nhiên.
 */

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import * as repository from "./spine.repository.js"
import { spineSchema } from "./spine.schema.js"
import type { Change, Spine, SpineRecord } from "./spine.types.js"
import {
  ABSENT,
  INVARIANT_VIOLATION,
  OP_INVALID,
  ROOT_PATH,
  isAbsent,
  transactionSchema,
  type ApplyResult,
  type Op,
  type PlanResult,
  type PlannedChange,
  type PreviewResult,
  type Referrer,
  type RejectRule,
  type Transaction,
  type Violation
} from "./op.types.js"
import { PathError, isRecord, parentArrayPath, parsePath, resolve, selectorFor, formatPath, tryResolve } from "./path-resolver.js"
import { checkInvariants } from "./invariants.js"
import { RemovedIds, planCascade, planFeatureRenumber, planScreenQueueAppend } from "./cascade.js"
import { allocateId, allocatesIds, isPlaceholderId, substituteDeep, substitutePlaceholders } from "./id-allocator.js"
import { withElementDefaults } from "./element-defaults.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const CHANGE_RANGE_INVALID = "CHANGE_RANGE_INVALID"

/** Lô bị từ chối. `code` = OP_INVALID (op sai) hoặc INVARIANT_VIOLATION (bất biến). HTTP 422. */
export class TransactionRejectedError extends ApiError {
  readonly violations: Violation[]
  readonly referrers: Referrer[]

  constructor(code: typeof OP_INVALID | typeof INVARIANT_VIOLATION, violations: Violation[], referrers: Referrer[] = []) {
    const head = violations[0]?.message ?? "Transaction bị từ chối"
    super(422, violations.length > 1 ? `${head} (+${violations.length - 1} vi phạm khác)` : head, code)
    this.violations = violations
    this.referrers = referrers
  }
}

/** Trần vòng cascade — chỉ để chặn lỗi lập trình gây lặp vô hạn. */
const MAX_CASCADE_ROUNDS = 50

const clone = <T>(value: T): T => structuredClone(value)

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

type Draft = Omit<PlannedChange, "seq" | "at" | "by" | "txn" | "step_id">

interface WorkState {
  spine: Spine
  removed: RemovedIds
  ops: Op[]
  drafts: Draft[]
  /**
   * Trạng thái ngay sau lần thay gốc (clone/migrate hoặc revert của chúng) cuối cùng trong lô.
   * Bất biến "không được xoá" (1, 2, 8) so với mốc này thay vì Spine trước lô — thay nguyên
   * nội dung không phải là xoá từng phần tử.
   */
  baseline: Spine | null
  /** Id tạm (`$new1`) → id server đã cấp trong lô này (WP-2). */
  placeholders: Map<string, string>
}

const opError = (rule: RejectRule, path: string, message: string): PathError => new PathError(rule, path, message)

// ─── áp một op ───────────────────────────────────────────────────

const reasonOf = (op: Op): string | null => op.reason ?? null

/** Tên collection của segment cuối: `functions[id=F1].validations[id=V2]` → `validations`. */
const lastKey = (path: string): string => {
  const segments = parsePath(path)
  return segments[segments.length - 1].key
}

/** Mảng object có id (actors, functions, validations…) chỉ được sửa bằng add/remove từng phần tử. */
const isEntityArray = (value: unknown): boolean => Array.isArray(value) && value.some(isRecord)

const applySet = (state: WorkState, op: Op): void => {
  if (op.value === undefined) throw opError("op_value_missing", op.path, `Op set thiếu value: "${op.path}"`)
  const target = resolve(state.spine, op.path)

  if (target.kind === "append") throw opError("op_not_allowed", op.path, `Op set không nhận path kết thúc bằng []: "${op.path}"`)

  if (target.kind === "field") {
    if (target.lockedKeys.includes(target.key)) {
      throw opError("key_change_forbidden", op.path, `Không được đổi khoá "${target.key}" của phần tử: "${op.path}"`)
    }
    if (isEntityArray(target.value) || isEntityArray(op.value)) {
      if (expandEntityArraySet(state, op, target.value)) return
      throw opError("op_not_allowed", op.path, `Mảng phần tử có id phải sửa bằng add/remove từng phần tử: "${op.path}"`)
    }
    const before = target.exists ? clone(target.value) : ABSENT
    if (isDeepStrictEqual(target.value, op.value)) return
    target.parent[target.key] = clone(op.value)
    state.drafts.push({ op: op.op, path: target.canonical, before, value: clone(op.value), reason: reasonOf(op) })
    return
  }

  // thay nguyên phần tử: giữ nguyên khoá định danh
  const element = target.value
  if (!isRecord(element) || !isRecord(op.value)) {
    throw opError("op_not_allowed", op.path, `Op set trên phần tử vô hướng không được hỗ trợ — dùng remove + add: "${op.path}"`)
  }
  const next = withElementDefaults(lastKey(op.path), op.value) as Record<string, unknown>
  for (const key of target.lockedKeys) {
    if (String(next[key]) !== String(element[key])) {
      throw opError("key_change_forbidden", op.path, `Không được đổi khoá "${key}" của phần tử: "${op.path}"`)
    }
  }
  if (isDeepStrictEqual(element, next)) return
  const collection = lastKey(op.path)
  if (collection === "functions") {
    const kept = new Set(Array.isArray(next.validations) ? next.validations.filter(isRecord).map((v) => v.id) : [])
    for (const v of Array.isArray(element.validations) ? element.validations.filter(isRecord) : []) {
      if (typeof v.id === "string" && !kept.has(v.id)) state.removed.add("validations", v.id)
    }
  }
  target.parent[target.key] = clone(next)
  state.drafts.push({ op: op.op, path: target.canonical, before: clone(element), value: clone(next), reason: reasonOf(op) })
}

/**
 * WP-2: phần tử thêm vào collection có id mà thiếu `id` hoặc mang id tạm (`$new1`) ⇒ server cấp id kế tiếp.
 * Id tạm được ghi vào `state.placeholders` để các op sau trong lô tham chiếu tới nó được thay bằng id thật.
 */
const withAllocatedId = (state: WorkState, path: string, value: unknown): unknown => {
  if (!isRecord(value)) return value
  const segments = parsePath(path)
  const collection = segments[segments.length - 1].key
  const nested = segments.length === 2 && collection === "validations"
  if (!allocatesIds(collection) || (segments.length !== 1 && !nested)) return value

  const current = value.id
  const missing = current === undefined || current === null || current === ""
  if (!missing && !isPlaceholderId(current)) return value

  const parent = nested ? segments[0].selector : undefined
  const parentId = parent?.kind === "match" ? (parent.pairs.find(([k]) => k === "id")?.[1] ?? null) : null
  const id = allocateId(state.spine, collection, parentId)
  if (id === null) return value
  if (isPlaceholderId(current)) state.placeholders.set(current, id)
  return { ...value, id }
}

/**
 * `set` cả một mảng phần tử có id LỒNG trong một phần tử (vd `functions[id=FN001].validations`) ⇒ tách
 * thành remove/set/add từng phần tử (BUG-08: sửa validations qua edit tool bị `op_not_allowed`). Mảng
 * cấp gốc (`set actors [...]`) KHÔNG được tách: một lô thiếu vài phần tử sẽ xoá hàng loạt — vẫn từ chối.
 * Trả `false` khi không tách được (để caller báo lỗi như cũ).
 */
const expandEntityArraySet = (state: WorkState, op: Op, current: unknown): boolean => {
  const segments = parsePath(op.path)
  if (segments.length < 2 || !Array.isArray(current) || !Array.isArray(op.value)) return false
  if (!current.every((el) => isRecord(el) && typeof el.id === "string")) return false
  if (!op.value.every(isRecord)) return false

  const wanted = op.value as Record<string, unknown>[]
  const wantedIds = new Set(wanted.map((el) => el.id).filter((id): id is string => typeof id === "string" && !isPlaceholderId(id)))
  const existing = current as Record<string, unknown>[]
  const reason = op.reason === undefined ? {} : { reason: op.reason }

  for (const el of existing) {
    if (!wantedIds.has(el.id as string)) applyRemove(state, { op: "remove", path: `${op.path}[id=${String(el.id)}]`, ...reason })
  }
  for (const el of wanted) {
    const id = el.id
    const known = typeof id === "string" && existing.some((x) => x.id === id)
    if (known) applySet(state, { op: "set", path: `${op.path}[id=${id}]`, value: el, ...reason })
    else applyAdd(state, { op: "add", path: `${op.path}[]`, value: el, ...reason })
  }
  return true
}

const applyAdd = (state: WorkState, op: Op): void => {
  if (op.value === undefined) throw opError("op_value_missing", op.path, `Op add thiếu value: "${op.path}"`)
  const target = resolve(state.spine, op.path)
  if (target.kind !== "append") {
    throw opError("op_not_allowed", op.path, `Op add phải nhắm mảng dạng "arr[]": "${op.path}"`)
  }

  const value = withAllocatedId(state, op.path, isRecord(op.value) ? withElementDefaults(lastKey(op.path), op.value) : op.value)
  const selector = selectorFor(value)
  if (isRecord(value)) {
    if (typeof value.id === "string" && target.parent.some((el) => isRecord(el) && el.id === value.id)) {
      throw opError(
        "duplicate_id",
        op.path,
        `Phần tử id "${value.id}" đã tồn tại trong "${op.path}" — muốn thêm phần tử MỚI thì bỏ trường "id" (hoặc dùng id tạm "$new1") để server cấp id; muốn sửa phần tử đó thì dùng set`
      )
    }
  } else if (target.parent.some((el) => !isRecord(el) && isDeepStrictEqual(el, value))) {
    throw opError("duplicate_id", op.path, `Giá trị "${String(value)}" đã có trong "${op.path}"`)
  }

  target.parent.push(clone(value))
  const segments = parsePath(target.canonical)
  const last = segments[segments.length - 1]
  const canonical = selector ? formatPath([...segments.slice(0, -1), { key: last.key, selector }]) : target.canonical
  state.drafts.push({ op: op.op, path: canonical, before: ABSENT, value: clone(value), reason: reasonOf(op) })
}

const applyRemove = (state: WorkState, op: Op): void => {
  const target = resolve(state.spine, op.path)
  if (target.kind === "append") throw opError("op_not_allowed", op.path, `Op remove cần chỉ rõ phần tử: "${op.path}"`)

  if (target.kind === "field") {
    if (target.lockedKeys.includes(target.key)) {
      throw opError("key_change_forbidden", op.path, `Không được xoá khoá "${target.key}" của phần tử: "${op.path}"`)
    }
    if (!target.exists) throw opError("path_not_resolved", op.path, `Field không tồn tại: "${op.path}"`)
    const before = clone(target.value)
    delete target.parent[target.key]
    state.drafts.push({ op: op.op, path: target.canonical, before, value: ABSENT, reason: reasonOf(op) })
    return
  }

  const [element] = target.parent.splice(target.key, 1)
  state.removed.trackElement(lastKey(op.path), element)
  state.drafts.push({ op: op.op, path: target.canonical, before: element, value: { ...ABSENT, index: target.key }, reason: reasonOf(op) })
}

const renumberValueSchema = z.array(z.string().min(1)).optional()

/**
 * `renumber features[]` hoặc `renumber functions[]`: đặt lại `order` liên tục từ 0 (functions: theo nhóm
 * feature × screen/non-screen). `value` tuỳ chọn là danh sách id theo thứ tự mong muốn; id không có
 * trong danh sách xếp sau, giữ thứ tự `order` hiện tại. Mỗi phần tử đổi order ghi một change `renumber`.
 */
const applyRenumber = (state: WorkState, op: Op): void => {
  if (op.path !== "features[]" && op.path !== "functions[]") {
    throw opError("op_not_allowed", op.path, `renumber chỉ nhận "features[]" hoặc "functions[]": "${op.path}"`)
  }
  const parsed = renumberValueSchema.safeParse(op.value)
  if (!parsed.success) throw opError("op_not_allowed", op.path, `value của renumber phải là mảng id`)
  const wanted = parsed.data ?? []
  const rank = (id: string) => (wanted.includes(id) ? wanted.indexOf(id) : Number.MAX_SAFE_INTEGER)

  const items: { id: string; order: number; group: string; i: number }[] =
    op.path === "features[]"
      ? state.spine.features.map((f, i) => ({ id: f.id, order: f.order, group: "", i }))
      : state.spine.functions.map((f, i) => ({ id: f.id, order: f.order, group: `${f.feature_id}|${f.screen_id === null}`, i }))

  const groups = new Map<string, typeof items>()
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item])

  for (const group of groups.values()) {
    group.sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order || a.i - b.i)
    group.forEach((item, order) => {
      if (item.order === order) return
      const collection = op.path === "features[]" ? "features" : "functions"
      const path = `${collection}[id=${item.id}].order`
      const target = resolve(state.spine, path)
      if (target.kind !== "field") return
      target.parent.order = order
      state.drafts.push({ op: "renumber", path, before: item.order, value: order, reason: reasonOf(op) })
    })
  }
}

const applyRootReplace = (state: WorkState, op: Op): void => {
  if (op.path !== ROOT_PATH) throw opError("op_not_allowed", op.path, `Op ${op.op} phải có path "${ROOT_PATH}"`)
  const parsed = spineSchema.safeParse(op.value)
  if (!parsed.success) throw opError("schema_invalid", op.path, `value của ${op.op} không phải Spine hợp lệ: ${z.prettifyError(parsed.error)}`)

  const { spine_version: _ignored, ...content } = parsed.data
  const { spine_version: currentVersion, ...before } = state.spine
  state.spine = { ...clone(content), spine_version: currentVersion }
  state.baseline = clone(state.spine)
  state.drafts.push({ op: op.op, path: ROOT_PATH, before: clone(before), value: clone(content), reason: reasonOf(op) })
}

const applyOp = (state: WorkState, op: Op): void => {
  switch (op.op) {
    case "set":
      return applySet(state, op)
    case "add":
      return applyAdd(state, op)
    case "remove":
      return applyRemove(state, op)
    case "renumber":
      return applyRenumber(state, op)
    case "clone":
    case "migrate":
      return applyRootReplace(state, op)
  }
}

// ─── kế hoạch thuần (không DB) ───────────────────────────────────

const schemaViolations = (spine: Spine): Violation[] => {
  const parsed = spineSchema.safeParse(spine)
  if (parsed.success) return []
  return parsed.error.issues.map((issue) => ({
    rule: "schema_invalid" as const,
    path: issue.path.map(String).join("."),
    message: `Sai schema tại "${issue.path.map(String).join(".")}": ${issue.message}`
  }))
}

export interface PlanOptions {
  /** Seq của change đầu tiên (repository.nextSeq). */
  startSeq: number
  now?: Date
}

/**
 * Áp lô lên bản sao của `spine` — hàm thuần, không đụng DB, không đổi `spine_version`.
 * Ném `TransactionRejectedError` nếu op sai hoặc vi phạm bất biến.
 */
export const planTransaction = (spine: Spine, txn: Transaction, options: PlanOptions): PlanResult & { txn: string } => {
  const txnId = txn.txn ?? randomUUID()
  const before = clone(spine)
  const state: WorkState = { spine: clone(spine), removed: new RemovedIds(), ops: [], drafts: [], baseline: null, placeholders: new Map() }

  const run = (raw: Op, index?: number) => {
    // Id tạm đã cấp ở op trước trong lô ⇒ thay bằng id thật trong path và value
    const op: Op =
      state.placeholders.size === 0
        ? raw
        : { ...raw, path: substitutePlaceholders(raw.path, state.placeholders), ...(raw.value === undefined ? {} : { value: substituteDeep(raw.value, state.placeholders) }) }
    const draftsBefore = state.drafts.length
    try {
      applyOp(state, op)
      // Op add được cấp id: lưu bản mang id thật (preview hiện đúng id, lô ghi lại tái lập được)
      const added = op.op === "add" && state.drafts.length > draftsBefore ? state.drafts[state.drafts.length - 1].value : undefined
      const allocated = isRecord(op.value) && isRecord(added) && added.id !== op.value.id
      state.ops.push(allocated ? { ...op, value: clone(added) } : op)
    } catch (err) {
      if (err instanceof PathError) {
        throw new TransactionRejectedError(OP_INVALID, [
          { rule: err.rule, path: err.path, message: err.message, ...(index === undefined ? {} : { op_index: index }) }
        ])
      }
      // BUG-04: phần tử sai hình (thiếu mảng…) làm code áp op ném TypeError ⇒ lỗi validate cho model sửa,
      // không phải 501.
      if (err instanceof TypeError) {
        throw new TransactionRejectedError(OP_INVALID, [
          { rule: "schema_invalid", path: op.path, message: `Op ${op.op} "${op.path}" sai hình dữ liệu: ${err.message}`, ...(index === undefined ? {} : { op_index: index }) }
        ])
      }
      throw err
    }
  }

  txn.ops.forEach((op, i) => run(op.reason === undefined && txn.reason !== undefined ? { ...op, reason: txn.reason } : op, i))

  // cascade tới điểm bất động
  const referrers = new Map<string, Referrer>()
  let invariantViolations: Violation[]
  try {
    for (let round = 0; ; round++) {
      if (round >= MAX_CASCADE_ROUNDS) throw new Error(`Cascade không hội tụ sau ${MAX_CASCADE_ROUNDS} vòng`)
      const plan = planCascade(state.spine, state.removed)
      for (const r of plan.referrers) referrers.set(r.path, r)
      if (plan.ops.length === 0) break
      for (const op of plan.ops) run(op)
    }
    for (const op of planFeatureRenumber(state.spine, state.removed)) run(op)
    for (const op of planScreenQueueAppend(state.spine, before)) run(op)
    invariantViolations = checkInvariants(state.spine, state.baseline ?? before)
  } catch (err) {
    // BUG-04 (lớp phòng thủ): dữ liệu sai hình lọt tới cascade/bất biến ⇒ schema báo lỗi cho model, không 501
    if (!(err instanceof TypeError)) throw err
    const schemaErrors = schemaViolations(state.spine)
    throw new TransactionRejectedError(OP_INVALID, schemaErrors.length > 0 ? schemaErrors : [{ rule: "schema_invalid", message: `Dữ liệu sai hình: ${err.message}` }])
  }
  if (invariantViolations.length > 0) {
    throw new TransactionRejectedError(INVARIANT_VIOLATION, invariantViolations, [...referrers.values()])
  }
  const schemaErrors = schemaViolations(state.spine)
  if (schemaErrors.length > 0) throw new TransactionRejectedError(OP_INVALID, schemaErrors)

  const at = (options.now ?? new Date()).toISOString()
  const changes: PlannedChange[] = state.drafts.map((draft, i) => ({
    ...draft,
    seq: options.startSeq + i,
    txn: txnId,
    at,
    by: txn.by,
    step_id: txn.step_id ?? null
  }))

  return { spine: state.spine, ops: state.ops, changes, txn: txnId }
}

// ─── revert (thuần) ──────────────────────────────────────────────

/**
 * Revert chỉ hợp lệ khi giá trị hiện tại đúng là giá trị change đó đã ghi. Khác ⇒ có thay đổi sau dải
 * revert đụng cùng chỗ; đặt lại `before` sẽ ghi đè im lặng thay đổi đó.
 */
const revertConflict = (change: Change, detail: string): PathError =>
  opError("revert_conflict", change.path, `"${change.path}" đã bị thay đổi sau đó (${detail}) — cần revert các thay đổi sau trước`)

/** Áp nghịch đảo một change lên `state`, ghi draft `op: "revert"`. */
const invertChange = (state: WorkState, change: Change): void => {
  const reason = `Revert seq ${change.seq}`

  if (change.path === ROOT_PATH) {
    const parsed = spineSchema.omit({ spine_version: true }).safeParse(change.before)
    if (!parsed.success) throw opError("schema_invalid", ROOT_PATH, `before của seq ${change.seq} không phải Spine hợp lệ`)
    const { spine_version: currentVersion, ...current } = state.spine
    if (!isDeepStrictEqual(current, change.value)) throw revertConflict(change, "nội dung Spine khác bản clone/migrate")
    state.spine = { ...clone(parsed.data), spine_version: currentVersion }
    state.baseline = clone(state.spine)
    state.drafts.push({ op: "revert", path: ROOT_PATH, before: current, value: clone(parsed.data), reason })
    return
  }

  // change đã xoá ⇒ chèn/khôi phục lại
  if (isAbsent(change.value)) {
    const arrayPath = change.value.index === undefined ? null : parentArrayPath(change.path)
    if (arrayPath !== null) {
      // Phần tử cùng khoá đã được thêm lại sau đó: chèn nữa sẽ trùng id
      if (tryResolve(state.spine, change.path)?.kind === "element") throw revertConflict(change, "phần tử cùng khoá đã tồn tại")
      const target = resolve(state.spine, arrayPath)
      if (target.kind !== "append") throw opError("path_not_resolved", change.path, `Không khôi phục được "${change.path}"`)
      const index = Math.min(change.value.index ?? target.parent.length, target.parent.length)
      target.parent.splice(index, 0, clone(change.before))
      state.drafts.push({ op: "revert", path: change.path, before: ABSENT, value: clone(change.before), reason })
      return
    }
    const target = resolve(state.spine, change.path)
    if (target.kind !== "field") throw opError("path_not_resolved", change.path, `Không khôi phục được "${change.path}"`)
    if (target.exists) throw revertConflict(change, "field đã có giá trị")
    target.parent[target.key] = clone(change.before)
    state.drafts.push({ op: "revert", path: change.path, before: ABSENT, value: clone(change.before), reason })
    return
  }

  const target = resolve(state.spine, change.path)

  // change đã tạo mới ⇒ xoá đi
  if (isAbsent(change.before)) {
    if (target.kind === "element") {
      if (!isDeepStrictEqual(target.value, change.value)) throw revertConflict(change, "phần tử đã bị sửa")
      const [element] = target.parent.splice(target.key, 1)
      state.drafts.push({ op: "revert", path: target.canonical, before: element, value: { ...ABSENT, index: target.key }, reason })
      return
    }
    if (target.kind === "field" && target.exists) {
      if (!isDeepStrictEqual(target.value, change.value)) throw revertConflict(change, "giá trị đã bị sửa")
      const before = clone(target.value)
      delete target.parent[target.key]
      state.drafts.push({ op: "revert", path: target.canonical, before, value: ABSENT, reason })
      return
    }
    throw opError("path_not_resolved", change.path, `Không revert được "${change.path}"`)
  }

  // change đã thay giá trị ⇒ đặt lại before
  if (target.kind === "append") throw opError("path_not_resolved", change.path, `Không revert được "${change.path}"`)
  const current = target.exists ? clone(target.value) : ABSENT
  if (!isDeepStrictEqual(current, change.value)) throw revertConflict(change, "giá trị đã bị sửa")
  if (target.kind === "field") target.parent[target.key] = clone(change.before)
  else target.parent[target.key] = clone(change.before)
  state.drafts.push({ op: "revert", path: target.canonical, before: current, value: clone(change.before), reason })
}

export interface RevertOptions {
  by: string
  startSeq: number
  txn?: string
  step_id?: string | null
  now?: Date
}

/** Revert thuần: áp nghịch đảo `changes` theo thứ tự seq giảm dần, kiểm bất biến cuối lô. */
export const planRevert = (spine: Spine, changes: Change[], options: RevertOptions): PlanResult & { txn: string } => {
  const before = clone(spine)
  const state: WorkState = { spine: clone(spine), removed: new RemovedIds(), ops: [], drafts: [], baseline: null, placeholders: new Map() }
  const ordered = [...changes].sort((a, b) => b.seq - a.seq)

  for (const change of ordered) {
    try {
      invertChange(state, change)
    } catch (err) {
      if (!(err instanceof PathError)) throw err
      throw new TransactionRejectedError(OP_INVALID, [{ rule: err.rule, path: err.path, message: `seq ${change.seq}: ${err.message}` }])
    }
  }

  // Màn khôi phục lại (undo xoá màn trong S-5) không phải "màn mới thêm" của bất biến 8
  const restoredScreenIds = new Set<string>()
  for (const draft of state.drafts) {
    const id = /^screens\[id=([^\]]+)\]$/.exec(draft.path)?.[1]
    if (id !== undefined && isAbsent(draft.before) && !isAbsent(draft.value)) restoredScreenIds.add(id)
  }

  const violations = [
    ...checkInvariants(state.spine, state.baseline ?? before, { restoredScreenIds }),
    ...schemaViolations(state.spine)
  ]
  if (violations.length > 0) {
    const code = violations.every((v) => v.rule === "schema_invalid" || !v.rule.startsWith("invariant_")) ? OP_INVALID : INVARIANT_VIOLATION
    throw new TransactionRejectedError(code, violations)
  }

  const txnId = options.txn ?? randomUUID()
  const at = (options.now ?? new Date()).toISOString()
  const planned: PlannedChange[] = state.drafts.map((draft, i) => ({
    ...draft,
    seq: options.startSeq + i,
    txn: txnId,
    at,
    by: options.by,
    step_id: options.step_id ?? null
  }))
  return { spine: state.spine, ops: [], changes: planned, txn: txnId }
}

// ─── API có DB ───────────────────────────────────────────────────

const assertVersion = (record: SpineRecord, baseVersion?: number): void => {
  if (baseVersion !== undefined && record.spine_version !== baseVersion) {
    throw new ApiError(
      409,
      "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.",
      repository.SPINE_VERSION_CONFLICT
    )
  }
}

const loadForWrite = async (projectId: string, baseVersion?: number): Promise<SpineRecord> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  assertVersion(record, baseVersion)
  return record
}

const parseTransaction = (txn: Transaction): Transaction => {
  const parsed = transactionSchema.safeParse(txn)
  if (!parsed.success) {
    throw new TransactionRejectedError(OP_INVALID, [{ rule: "path_invalid", message: `Transaction không hợp lệ: ${z.prettifyError(parsed.error)}` }])
  }
  return parsed.data
}

/** Áp một transaction và ghi DB. Xem mô tả đầu file. */
export const applyTransaction = async (projectId: string, txn: Transaction): Promise<ApplyResult> => {
  const input = parseTransaction(txn)
  const record = await loadForWrite(projectId, input.base_version)
  const startSeq = await repository.nextSeq(projectId)
  const plan = planTransaction(stripRecord(record), input, { startSeq })

  // Mọi op trùng giá trị hiện tại: không ghi, không tăng version (tránh làm waiver hết hạn / section stale giả)
  if (plan.changes.length === 0) return { spine: record, changes: [], txn: null, spine_version: record.spine_version }

  const saved = await repository.applyAndSave(projectId, {
    spine: { ...plan.spine, projectId },
    baseVersion: input.base_version,
    changes: plan.changes
  })
  return { spine: saved.spine, changes: saved.changes, txn: plan.txn, spine_version: saved.spine.spine_version }
}

/**
 * Như `applyTransaction` nhưng không ghi. Vi phạm trả trong kết quả (`ok=false`), không ném.
 * Project cũ chưa có Spine: preview trên Spine rỗng (`init`) — preview không được tạo Spine.
 */
export const previewTransaction = async (
  projectId: string,
  txn: Transaction,
  init: repository.SpineInit = {}
): Promise<PreviewResult> => {
  const input = parseTransaction(txn)
  const record: SpineRecord = (await repository.get(projectId)) ?? { projectId, ...repository.createEmptySpine(init) }
  assertVersion(record, input.base_version)
  const txnId = input.txn ?? randomUUID()

  try {
    const plan = planTransaction(stripRecord(record), { ...input, txn: txnId }, { startSeq: 1 })
    return {
      ok: true,
      txn: txnId,
      base_version: input.base_version,
      ops: plan.ops,
      changes: plan.changes.map(({ op, path, before, value, reason }) => ({ op, path, before, value, reason })),
      violations: [],
      referrers: []
    }
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    return { ok: false, txn: txnId, base_version: input.base_version, ops: [], changes: [], violations: err.violations, referrers: err.referrers }
  }
}

export interface RevertRangeOptions {
  by: string
  /** Nếu có: kiểm khoá lạc quan như transaction thường. */
  base_version?: number
  step_id?: string | null
}

/**
 * Revert dải `changes[first_seq..last_seq]` bằng `before`, theo thứ tự ngược, trong MỘT txn mới
 * (`op: "revert"`). Dùng cho resume/regenerate (T13) và undo (T17).
 */
export const revertRange = async (
  projectId: string,
  firstSeq: number,
  lastSeq: number,
  options: RevertRangeOptions
): Promise<ApplyResult> => {
  if (!Number.isInteger(firstSeq) || !Number.isInteger(lastSeq) || firstSeq < 1 || lastSeq < firstSeq) {
    throw new ApiError(422, `Dải seq không hợp lệ: ${firstSeq}–${lastSeq}`, CHANGE_RANGE_INVALID)
  }
  const record = await loadForWrite(projectId, options.base_version)
  const changes = await repository.listChanges(projectId, { fromSeq: firstSeq, toSeq: lastSeq })
  if (changes.length !== lastSeq - firstSeq + 1) {
    throw new ApiError(422, `Dải seq ${firstSeq}–${lastSeq} không đầy đủ trong changes[]`, CHANGE_RANGE_INVALID)
  }

  const startSeq = await repository.nextSeq(projectId)
  const plan = planRevert(stripRecord(record), changes, { by: options.by, startSeq, step_id: options.step_id ?? null })
  const saved = await repository.applyAndSave(projectId, {
    spine: { ...plan.spine, projectId },
    baseVersion: record.spine_version,
    changes: plan.changes
  })
  return { spine: saved.spine, changes: saved.changes, txn: plan.txn, spine_version: saved.spine.spine_version }
}
