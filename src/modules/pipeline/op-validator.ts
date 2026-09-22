/**
 * op-validator.ts
 * ─────────────────────────────────────────────────────────────────
 * Kiểm lô op do model phát TRƯỚC khi đưa cho op engine ghi (Phases §4.1 "Op sai schema / path không
 * phân giải"): hình op (zod), path được phép ghi của step, rồi chạy thử `planTransaction` (T08) trên
 * Spine hiện tại — path resolve, schema field, cascade, 8 bất biến. Không ghi DB.
 *
 * FLF-177 fix-plan:
 * - `sanitizeModelOps` (BUG-03, BUG-29): field chỉ user/code được quyết — `screens[].detail_status`
 *   (để trống màn là quyết định của user, không phải của model), `assumptions[].status/confirmed_at`
 *   (xác nhận giả định là lời của user ở gate) — bị chuẩn hoá hoặc từ chối.
 * - Luật phạm vi `op_out_of_scope` (BUG-02): `set`/`remove` nhắm phần tử có id mà step KHÔNG được thấy
 *   trong projection ⇒ từ chối. Model tự đánh id kế tiếp rồi `set` đè lên function của màn khác là lỗi dữ
 *   liệu nghiêm trọng nhất lượt test — phần tử mới phải `add` không id (server cấp, WP-2).
 * - Lỗi ngoài dự kiến khi chạy thử (TypeError…) thành lỗi validate để model sửa (BUG-04), không 501.
 */

import { z } from "zod"
import { planTransaction, TransactionRejectedError } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import { parsePath, PathError } from "../spine/path-resolver.js"
import { isPlaceholderId } from "../spine/id-allocator.js"
import type { Spine } from "../spine/spine.types.js"

export interface ValidationError {
  /** `op_schema` · `path_not_writable` · `op_out_of_scope` · `op_not_allowed` · hoặc `rule` của op engine. */
  rule: string
  message: string
  path?: string
  op_index?: number
}

export interface ValidateOptions {
  /** Path gốc step được ghi (`actors`, `project.release_scope`). Không truyền ⇒ không giới hạn. */
  writable?: readonly string[]
  stepId?: string | null
  /**
   * Id model được thấy theo collection (từ projection của step — `visibleIdsOf`). Collection không có
   * trong map ⇒ không giới hạn (step không đọc collection đó thì path cũng chẳng phân giải được).
   */
  visibleIds?: ReadonlyMap<string, ReadonlySet<string>>
}

/** `actors[id=A01].name` thuộc `actors`; `project.release_scope.in` thuộc `project.release_scope` hoặc `project`. */
export const isWritablePath = (path: string, writable: readonly string[]): boolean =>
  writable.some((w) => path === w || path.startsWith(`${w}.`) || path.startsWith(`${w}[`))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Id mà model thấy trong projection, theo collection gốc. Selector `functions[screen_id=@loop]:id,name` ⇒
 * collection `functions`; hai selector cùng collection thì gộp. Selector không lấy `id` (vd `actors:name`)
 * không đóng góp — model không thấy id thì không được sửa theo id.
 */
export const visibleIdsOf = (projection: Record<string, unknown>): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>()
  for (const [selector, value] of Object.entries(projection)) {
    const collection = /^[a-z_]+/.exec(selector)?.[0]
    if (!collection || selector.slice(collection.length).startsWith(".") || !Array.isArray(value)) continue
    const ids = out.get(collection) ?? new Set<string>()
    for (const el of value) if (isRecord(el) && typeof el.id === "string") ids.add(el.id)
    out.set(collection, ids)
  }
  return out
}

/** `functions[id=FN005].name` → `{ collection: "functions", id: "FN005" }`; path khác ⇒ null. */
const targetOf = (path: string): { collection: string; id: string } | null => {
  try {
    const [first] = parsePath(path)
    if (first.selector?.kind !== "match") return null
    const id = first.selector.pairs.find(([k]) => k === "id")?.[1]
    return id === undefined ? null : { collection: first.key, id }
  } catch (err) {
    if (err instanceof PathError) return null
    throw err
  }
}

/** Id do chính lô này thêm (id tường minh hoặc id tạm) — `set` ngay sau `add` là hợp lệ. */
const idsAddedIn = (ops: readonly Op[]): Set<string> => {
  const out = new Set<string>()
  for (const op of ops) {
    if (op.op === "add" && isRecord(op.value) && typeof op.value.id === "string") out.add(op.value.id)
  }
  return out
}

/** Phần tử có tồn tại trong Spine không — id không tồn tại để engine báo `path_not_resolved` như cũ. */
const existsIn = (spine: Spine, collection: string, id: string): boolean => {
  const list = (spine as unknown as Record<string, unknown>)[collection]
  return Array.isArray(list) && list.some((el) => isRecord(el) && el.id === id)
}

const scopeErrors = (
  spine: Spine,
  ops: readonly Op[],
  visibleIds: ReadonlyMap<string, ReadonlySet<string>>,
  stepId: string | null | undefined
): ValidationError[] => {
  const added = idsAddedIn(ops)
  const errors: ValidationError[] = []
  ops.forEach((op, index) => {
    if (op.op !== "set" && op.op !== "remove") return
    const target = targetOf(op.path)
    if (!target || isPlaceholderId(target.id) || added.has(target.id)) return
    const visible = visibleIds.get(target.collection)
    if (!visible || visible.has(target.id) || !existsIn(spine, target.collection, target.id)) return
    errors.push({
      rule: "op_out_of_scope",
      op_index: index,
      path: op.path,
      message:
        `Step ${stepId ?? ""} không thấy ${target.collection}[id=${target.id}] trong projection — không được sửa/xoá phần tử ngoài phạm vi. ` +
        `Muốn thêm phần tử MỚI thì dùng op add vào "${target.collection}[]" và bỏ trống "id" (server cấp id).`
    })
  })
  return errors
}

// ─── field chỉ user/code quyết (BUG-03, BUG-29) ──────────────────

/**
 * Step rà giả định với user (B-2.1 Assumption Sweep, B-2.3, S-1.3): model ghi `status` theo đúng câu trả lời
 * user vừa đưa trong lượt Elicit. Step khác không được đổi `status` của giả định.
 */
export const ASSUMPTION_SWEEP_STEPS: ReadonlySet<string> = new Set(["B-2.1", "B-2.3", "S-1.3"])

const SCREEN_STATUS_PATH = /^screens\[[^\]]+\]\.detail_status$/
const ASSUMPTION_FIELD_PATH = /^assumptions\[id=([^\]]+)\]\.(confirmed_at|status)$/
const ASSUMPTION_PATH = /^assumptions\[id=([^\]]+)\]$/

export interface SanitizeResult {
  ops: unknown[]
  errors: ValidationError[]
}

/**
 * Chuẩn hoá op của MODEL (không áp cho lô user gửi qua `/changes`). Không thêm/bớt op ở giữa lô — `op_index`
 * của lỗi phải còn trỏ đúng lô model đã gửi (chỉ được nối thêm ở cuối).
 * - `add screens[]` ⇒ `detail_status: "pending"`; `set screens[id=X]` cả phần tử ⇒ giữ `detail_status` hiện tại;
 *   `set screens[].detail_status` ⇒ lỗi (BUG-03: model tự để trống màn Auth/Admin mà không hỏi user).
 * - `confirmed_at` luôn do server đặt (BUG-29: model bịa ngày xác nhận): `add assumptions[]` ⇒ `unconfirmed`/`null`;
 *   `set …confirmed_at` ⇒ thay bằng giá trị server; `set status = confirmed` ở step rà giả định ⇒ server đặt ngày.
 * - `status` của giả định chỉ đổi được ở `ASSUMPTION_SWEEP_STEPS`.
 */
export const sanitizeModelOps = (spine: Spine, ops: unknown, stepId: string | null = null, now: Date = new Date()): SanitizeResult => {
  if (!Array.isArray(ops)) return { ops: [], errors: [] }
  const base = stepId ? stepId.split("@")[0] : ""
  const sweep = ASSUMPTION_SWEEP_STEPS.has(base)
  const errors: ValidationError[] = []
  const at = now.toISOString()

  // status giả định sau lô (để suy ra confirmed_at đúng)
  const statusAfter = new Map<string, string>(spine.assumptions.map((a) => [a.id, a.status]))
  for (const raw of ops) {
    const op = userOpSchema.safeParse(raw)
    if (!op.success || op.data.op !== "set") continue
    const field = ASSUMPTION_FIELD_PATH.exec(op.data.path)
    if (field && field[2] === "status" && typeof op.data.value === "string") statusAfter.set(field[1], op.data.value)
    const whole = ASSUMPTION_PATH.exec(op.data.path)
    if (whole && isRecord(op.data.value) && typeof op.data.value.status === "string") statusAfter.set(whole[1], op.data.value.status)
  }
  const confirmedAtFor = (id: string): string | null => {
    if (statusAfter.get(id) !== "confirmed") return null
    const current = spine.assumptions.find((a) => a.id === id)
    return current?.status === "confirmed" && current.confirmed_at ? current.confirmed_at : at
  }
  const confirmedAtWritten = new Set<string>()

  const out = ops.map((raw, index): unknown => {
    const parsed = userOpSchema.safeParse(raw)
    if (!parsed.success) return raw
    const op = parsed.data

    if ((op.op === "set" || op.op === "remove") && SCREEN_STATUS_PATH.test(op.path)) {
      errors.push({
        rule: "op_not_allowed",
        op_index: index,
        path: op.path,
        message: "detail_status của màn do vòng S-5 và user quyết — model không được đặt. Muốn để lại màn nào thì nêu trong notes để user quyết ở gate."
      })
      return op
    }

    const field = ASSUMPTION_FIELD_PATH.exec(op.path)
    if (field && op.op === "set") {
      if (field[2] === "confirmed_at") {
        confirmedAtWritten.add(field[1])
        return { ...op, value: confirmedAtFor(field[1]) }
      }
      if (!sweep) {
        errors.push({ rule: "op_not_allowed", op_index: index, path: op.path, message: "Chỉ user xác nhận/bác bỏ giả định (ở gate hoặc bước rà giả định) — step này không được đổi status" })
      }
      return op
    }
    if (field && op.op === "remove") {
      errors.push({ rule: "op_not_allowed", op_index: index, path: op.path, message: "Không được xoá field của giả định" })
      return op
    }

    if (op.op === "add" && op.path === "screens[]" && isRecord(op.value)) {
      return { ...op, value: { ...op.value, detail_status: "pending" } }
    }
    if (op.op === "add" && op.path === "assumptions[]" && isRecord(op.value)) {
      return { ...op, value: { ...op.value, status: "unconfirmed", confirmed_at: null } }
    }
    if (op.op === "set" && isRecord(op.value)) {
      const screenId = /^screens\[id=([^\]]+)\]$/.exec(op.path)?.[1]
      const screen = screenId ? spine.screens.find((s) => s.id === screenId) : undefined
      if (screen) return { ...op, value: { ...op.value, detail_status: screen.detail_status } }
      const assumptionId = ASSUMPTION_PATH.exec(op.path)?.[1]
      const assumption = assumptionId ? spine.assumptions.find((a) => a.id === assumptionId) : undefined
      if (assumption && assumptionId) {
        confirmedAtWritten.add(assumptionId)
        const status = sweep && typeof op.value.status === "string" ? op.value.status : assumption.status
        return { ...op, value: { ...op.value, status, confirmed_at: sweep ? confirmedAtFor(assumptionId) : assumption.confirmed_at } }
      }
    }
    return op
  })

  // status đổi ở step rà giả định mà lô không kèm confirmed_at ⇒ nối thêm op đặt ngày (ở cuối — không lệch op_index)
  if (sweep) {
    for (const a of spine.assumptions) {
      if (confirmedAtWritten.has(a.id) || statusAfter.get(a.id) === a.status) continue
      const value = confirmedAtFor(a.id)
      if (value !== a.confirmed_at) out.push({ op: "set", path: `assumptions[id=${a.id}].confirmed_at`, value, reason: "confirmed_at do server đặt" })
    }
  }
  return { ops: out, errors }
}

export const validateOps = (spine: Spine, ops: unknown, options: ValidateOptions = {}): ValidationError[] => {
  const list = z.array(z.unknown()).safeParse(ops)
  if (!list.success) return [{ rule: "op_schema", message: "`ops` phải là mảng" }]

  const errors: ValidationError[] = []
  const parsed: Op[] = []
  list.data.forEach((raw, index) => {
    const op = userOpSchema.safeParse(raw)
    if (!op.success) {
      errors.push({ rule: "op_schema", op_index: index, message: `Op #${index} sai hình: ${z.prettifyError(op.error)}` })
      return
    }
    if (options.writable && !isWritablePath(op.data.path, options.writable)) {
      errors.push({
        rule: "path_not_writable",
        op_index: index,
        path: op.data.path,
        message: `Step ${options.stepId ?? ""} không được ghi "${op.data.path}". Được ghi: ${options.writable.join(", ")}`
      })
      return
    }
    parsed.push(op.data)
  })
  if (errors.length > 0 || parsed.length === 0) return errors

  if (options.visibleIds) {
    const outOfScope = scopeErrors(spine, parsed, options.visibleIds, options.stepId)
    if (outOfScope.length > 0) return outOfScope
  }

  try {
    planTransaction(spine, { base_version: spine.spine_version, ops: parsed, by: "op-validator", step_id: options.stepId ?? null }, { startSeq: 1 })
    return []
  } catch (err) {
    if (err instanceof TransactionRejectedError) {
      return err.violations.map((v) => ({
        rule: v.rule,
        message: v.message,
        ...(v.path === undefined ? {} : { path: v.path }),
        ...(v.op_index === undefined ? {} : { op_index: v.op_index })
      }))
    }
    // BUG-04: lỗi code khi chạy thử lô (dữ liệu sai hình) — để model sửa, không để rơi thành 501
    if (err instanceof TypeError || err instanceof RangeError) {
      return [{ rule: "schema_invalid", message: `Lô op làm hỏng dữ liệu khi áp thử: ${err.message}` }]
    }
    throw err
  }
}
