/**
 * op-validator.ts
 * ─────────────────────────────────────────────────────────────────
 * Kiểm lô op do model phát TRƯỚC khi đưa cho op engine ghi (Phases §4.1 "Op sai schema / path không
 * phân giải"): hình op (zod), path được phép ghi của step, rồi chạy thử `planTransaction` (T08) trên
 * Spine hiện tại — path resolve, schema field, cascade, 8 bất biến. Không ghi DB.
 */

import { z } from "zod"
import { planTransaction, TransactionRejectedError } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"

export interface ValidationError {
  /** `op_schema` · `path_not_writable` · hoặc `rule` của op engine (`path_not_resolved`, `invariant_*`…). */
  rule: string
  message: string
  path?: string
  op_index?: number
}

export interface ValidateOptions {
  /** Path gốc step được ghi (`actors`, `project.release_scope`). Không truyền ⇒ không giới hạn. */
  writable?: readonly string[]
  stepId?: string | null
}

/** `actors[id=A01].name` thuộc `actors`; `project.release_scope.in` thuộc `project.release_scope` hoặc `project`. */
export const isWritablePath = (path: string, writable: readonly string[]): boolean =>
  writable.some((w) => path === w || path.startsWith(`${w}.`) || path.startsWith(`${w}[`))

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

  try {
    planTransaction(spine, { base_version: spine.spine_version, ops: parsed, by: "op-validator", step_id: options.stepId ?? null }, { startSeq: 1 })
    return []
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    return err.violations.map((v) => ({
      rule: v.rule,
      message: v.message,
      ...(v.path === undefined ? {} : { path: v.path }),
      ...(v.op_index === undefined ? {} : { op_index: v.op_index })
    }))
  }
}
