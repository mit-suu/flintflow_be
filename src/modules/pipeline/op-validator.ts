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
 * - Lô đụng `entities`: ERD kết quả phải liên thông, mọi quan hệ có động từ, không cặp trỏ lẫn nhau
 *   (`erdShapeErrors`) — sai thì model sinh lại, không ghi rồi mới cắm cờ.
 */

import { z } from "zod"
import { planTransaction, TransactionRejectedError } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import { parsePath, PathError } from "../spine/path-resolver.js"
import { isPlaceholderId } from "../spine/id-allocator.js"
import type { Spine } from "../spine/spine.types.js"
import { orphanEntities } from "../spine/deterministic-check.js"
import { stampAddendum } from "../spine/addendum-stamp.js"
import {
  BRIEF_EXTRACTION_STEP,
  BRIEF_PROJECT_WRITE_MESSAGE,
  briefCoreEntries,
  hasBriefCore,
  isBriefCoreTopic,
  isBriefPhase,
  writesProjectVisionOrGoals
} from "../spine/brief-core.js"

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
  /**
   * Path thật của các giả định cổng vừa nói (FLF-232): revision được ghi đúng các path này (và bên dưới) dù nằm ngoài
   * `writable` / projection của step — user sửa điều AI tạm hiểu thì sửa ở chỗ nó nằm, không phải ở bước của nó.
   */
  extraPaths?: readonly string[]
}

/** `op.path` đúng bằng hoặc nằm dưới một path trong `extraPaths` (đã chuẩn hoá selector). */
const isExtraPath = (path: string, extraPaths: readonly string[] | undefined): boolean =>
  (extraPaths ?? []).some((raw) => {
    const extra = String(normalizeSelectorPath(raw)).trim()
    return extra !== "" && !extra.endsWith("[]") && (path === extra || path.startsWith(`${extra}.`) || path.startsWith(`${extra}[`))
  })

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
  stepId: string | null | undefined,
  extraPaths?: readonly string[]
): ValidationError[] => {
  const added = idsAddedIn(ops)
  const errors: ValidationError[] = []
  ops.forEach((op, index) => {
    if (op.op !== "set" && op.op !== "remove") return
    if (isExtraPath(op.path, extraPaths)) return
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

/**
 * S-1.1 được ghi `addendum` chỉ để sửa nghĩa của tầm nhìn/mục tiêu: `set`/`remove` phải nhắm entry lõi hiện có,
 * `add` phải mang `topic` lõi. Entry khác của addendum thuộc về Brief (B-*) và B-2.2.
 */
const briefCoreScopeErrors = (spine: Spine, ops: readonly Op[]): ValidationError[] => {
  const added = idsAddedIn(ops)
  const errors: ValidationError[] = []
  ops.forEach((op, index) => {
    if (op.path !== "addendum" && op.path !== "addendum[]" && !op.path.startsWith("addendum[")) return
    let ok = false
    if (op.op === "add") ok = isRecord(op.value) && isBriefCoreTopic(op.value.topic)
    else {
      const target = targetOf(op.path)
      const entry = target ? spine.addendum.find((a) => a.id === target.id) : undefined
      ok = target !== null && (added.has(target.id) || (entry !== undefined && isBriefCoreTopic(entry.topic)))
    }
    if (ok) return
    errors.push({
      rule: "op_out_of_scope",
      op_index: index,
      path: op.path,
      message: `Step ${BRIEF_EXTRACTION_STEP} chỉ được sửa entry addendum topic vision/goals (add phải mang topic vision hoặc goals) — entry khác thuộc về Brief.`
    })
  })
  return errors
}

const setsProjectField = (ops: readonly Op[], field: "vision" | "goals"): Op | undefined =>
  ops.find(
    (op) =>
      op.op === "set" &&
      (op.path.replace(/\s+/g, "") === `project.${field}` || (op.path === "project" && isRecord(op.value) && field in op.value))
  )

const projectFieldValue = (op: Op | undefined, field: "vision" | "goals"): unknown =>
  op === undefined ? undefined : op.path === "project" && isRecord(op.value) ? op.value[field] : op.value

/**
 * S-1.1 phải dựng lại `project.vision` + `project.goals[]` (tiếng Anh) từ addendum lõi mỗi lần soạn (`draft`/`regenerate`),
 * và cả khi revision đổi addendum. Dự án không có addendum lõi (cũ, import) giữ hành vi cũ ⇒ không kiểm.
 * Đếm mục tiêu theo addendum SAU lô, để lô revision thêm/bỏ entry `goals` được so đúng.
 */
export const briefExtractionErrors = (spine: Spine, ops: readonly Op[], stepId: string | null | undefined, callKind: string): ValidationError[] => {
  if (stepId !== BRIEF_EXTRACTION_STEP) return []
  const touchesAddendum = ops.some((op) => op.path === "addendum" || op.path.startsWith("addendum["))
  const required = callKind === "draft" || callKind === "regenerate" || (callKind === "revision" && touchesAddendum)
  const goalsOp = setsProjectField(ops, "goals")
  // Lô nào đặt project.goals cũng phải khớp 1:1 với entry goals (kể cả revision không đụng addendum)
  if (!required && goalsOp === undefined) return []

  let after = spine
  if (ops.length > 0) {
    try {
      after = planTransaction(spine, { base_version: spine.spine_version, ops: [...ops], by: "op-validator", step_id: stepId }, { startSeq: 1 }).spine
    } catch (err) {
      // Lô hỏng do lý do khác: validateOps đã báo; ở đây so với addendum hiện tại
      if (!(err instanceof TransactionRejectedError) && !(err instanceof TypeError) && !(err instanceof RangeError)) throw err
    }
  }
  if (!hasBriefCore(after)) return []

  const core = briefCoreEntries(after)
  const errors: ValidationError[] = []
  const vision = projectFieldValue(setsProjectField(ops, "vision"), "vision")
  // Chỉ đòi field mà addendum có nguồn: không có entry vision/goals thì không ép model bịa
  if (required && core.vision !== null && (typeof vision !== "string" || vision.trim() === "")) {
    errors.push({
      rule: "brief_extraction_incomplete",
      path: "project.vision",
      message: "Step S-1.1 phải có op set project.vision (một câu tiếng Anh, từ content_en của entry addendum topic vision)."
    })
  }
  const goals = projectFieldValue(goalsOp, "goals")
  if (!Array.isArray(goals)) {
    if (required && core.goals.length > 0) {
      errors.push({
        rule: "brief_extraction_incomplete",
        path: "project.goals",
        message: `Step S-1.1 phải có op set project.goals (mảng ${core.goals.length} mục tiêu tiếng Anh, 1:1 theo thứ tự các entry addendum topic goals, từ content_en).`
      })
    }
  } else if (goals.length !== core.goals.length) {
    errors.push({
      rule: "brief_extraction_incomplete",
      path: "project.goals",
      message: `project.goals có ${goals.length} mục nhưng addendum có ${core.goals.length} entry topic goals — phải 1:1, không gộp, không bịa thêm.`
    })
  }
  return errors
}

// ─── field chỉ user/code quyết (BUG-03, BUG-29) ──────────────────

/**
 * Step rà giả định với user (B-2.1 Assumption Sweep, B-2.3, S-1.3): model ghi `status` theo đúng câu trả lời
 * user vừa đưa trong lượt Elicit. Step khác không được đổi `status` của giả định.
 */
export const ASSUMPTION_SWEEP_STEPS: ReadonlySet<string> = new Set(["B-2.1", "B-2.3", "S-1.3"])

/**
 * Trong các step rà giả định này, `status` chỉ đổi được khi user đã quyết trong CHÍNH lượt này (`SanitizeOptions.userDecided`: câu trả lời
 * trên thẻ hoặc tin chat của step, hoặc lời sửa ở cổng). Không có thì model tự "xác nhận" kèm lý do bịa (gặp thật ở B-2.1) — giữ nguyên status.
 */
export const USER_DECISION_SWEEP_STEPS: ReadonlySet<string> = new Set(["B-2.1"])

/**
 * Selector thiếu tên khoá: `addendum[AD8]`, `functions[FN010]`. Model hay viết kiểu này trong GIÁ TRỊ
 * `assumptions[].path` (không phải path của op), và lô chết vì `dead_reference` sau 3 lượt thử — đúng lỗi
 * làm B-1.2 dừng ở lượt chạy thật 2026-09-23. Chuẩn hoá thành `addendum[id=AD8]` thay vì bắt model đoán lại.
 */
const SHORTHAND_SELECTOR = /^([a-z_]+)\[([^\]=,]+)\]((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/

export const normalizeSelectorPath = (path: unknown): unknown => {
  if (typeof path !== "string") return path
  const match = SHORTHAND_SELECTOR.exec(path.trim())
  return match ? `${match[1]}[id=${match[2]}]${match[3]}` : path
}

const SCREEN_STATUS_PATH = /^screens\[[^\]]+\]\.detail_status$/
const ASSUMPTION_FIELD_PATH = /^assumptions\[id=([^\]]+)\]\.(confirmed_at|status)$/
const ASSUMPTION_PATH = /^assumptions\[id=([^\]]+)\]$/

/** Tập giá trị của hai trường phân loại dự án — S-4/S-6/S-7 đọc đúng giá trị, chuỗi ghép "web_app,mobile_app" làm hỏng. */
export const PROJECT_ENUM_VALUES: Readonly<Record<"form_factor" | "stakes", readonly string[]>> = {
  form_factor: ["web_app", "mobile_app", "desktop_app", "api_service", "cli", "embedded"],
  stakes: ["internal", "production", "regulated"]
}

/** Câu giả định đã chuẩn hoá để so trùng: chữ thường, gộp khoảng trắng, bỏ dấu câu cuối. */
const assumptionKey = (text: unknown): string =>
  typeof text === "string" ? text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.,;:!]+$/u, "").trim() : ""

/** Giá trị `form_factor`/`stakes` ngoài tập hợp lệ trong một op `set` (path trường hoặc cả `project`); không có ⇒ null. */
const invalidProjectEnum = (path: string, value: unknown): keyof typeof PROJECT_ENUM_VALUES | null => {
  const field = /^project\.(form_factor|stakes)$/.exec(path)?.[1] as keyof typeof PROJECT_ENUM_VALUES | undefined
  const values: Record<string, unknown> | null = field ? { [field]: value } : path === "project" && isRecord(value) ? value : null
  if (!values) return null
  const keys = Object.keys(PROJECT_ENUM_VALUES) as (keyof typeof PROJECT_ENUM_VALUES)[]
  return keys.find((key) => key in values && values[key] !== null && !PROJECT_ENUM_VALUES[key].includes(String(values[key]))) ?? null
}

export interface SanitizeResult {
  ops: unknown[]
  errors: ValidationError[]
}

export interface SanitizeOptions {
  /**
   * Lượt `revision` ở cổng duyệt (FLF-232): lời sửa của user là lời xác nhận/bác bỏ giả định mà cổng vừa nói, nên model được
   * đổi `status` (server vẫn đặt `confirmed_at`) — nhưng CHỈ của các giả định trong `gateAssumptionIds`. Kèm luật
   * `assumption_path_mismatch` cho mọi giả định bị viết lại câu.
   */
  revision?: boolean
  /** Giả định cổng đang nói (`new_assumptions` của gate_ready / phase_gate): revision chỉ đổi `status` của các id này. */
  gateAssumptionIds?: ReadonlySet<string>
  /** User đã trả lời / nhắn chat trong lượt của step này — điều kiện để step trong `USER_DECISION_SWEEP_STEPS` được đổi status. */
  userDecided?: boolean
}

/** Path A và B chỉ cùng một chỗ trong Spine: bằng nhau, cái này là tổ tiên/hậu duệ của cái kia, hoặc `x[]` với `x[...]`. */
const pathsRelated = (a: string, b: string): boolean => {
  const norm = (p: string): string => String(normalizeSelectorPath(p)).trim()
  const [x, y] = [norm(a), norm(b)]
  if (x === y || x.startsWith(`${y}.`) || x.startsWith(`${y}[`) || y.startsWith(`${x}.`) || y.startsWith(`${x}[`)) return true
  const collection = (p: string): string => /^[a-z_]+/.exec(p)?.[0] ?? p
  return (x.endsWith("[]") || y.endsWith("[]")) && collection(x) === collection(y)
}

/** Câu mới khác câu hiện có. Giả định cũ chưa có `statement_vi` mà model điền thêm bản VI thì không tính là viết lại. */
const restatedText = (next: unknown, current: string | null | undefined): boolean =>
  typeof next === "string" && assumptionKey(current) !== "" && assumptionKey(next) !== assumptionKey(current)

const ASSUMPTION_STATEMENT_PATH = /^assumptions\[id=([^\]]+)\]\.(statement|statement_vi)$/

/**
 * Ở Brief, tầm nhìn/mục tiêu sống trong addendum lõi: giả định cũ có path `project.vision|goals` được coi là đã ghi trường thật
 * khi lô `set` `content` / `content_en` (hoặc cả entry) của một entry addendum cùng topic.
 */
const wroteBriefCoreEntry = (spine: Spine, parsed: readonly { op: Op }[], assumptionPath: string): boolean => {
  const topic = /^project\.(vision|goals)(?:$|[.[])/.exec(assumptionPath.replace(/\s+/g, ""))?.[1]
  if (!topic) return false
  return parsed.some(({ op }) => {
    if (op.op !== "set") return false
    const match = /^addendum\[id=([^\]]+)\](?:\.(?:content|content_en))?$/.exec(op.path)
    const entry = match ? spine.addendum.find((a) => a.id === match[1]) : undefined
    return entry !== undefined && entry.topic.trim().toLowerCase() === topic
  })
}

/**
 * Revision đổi câu của một giả định và xác nhận nó ⇒ lô PHẢI ghi luôn trường thật mà giả định nói về (`assumptions[id].path`).
 * Đổi câu mà không đổi trường thật là để Spine nói một đằng, giả định nói một nẻo; `set` sai path (vd sửa `project.stakes`
 * khi giả định nói về `project.form_factor`) không khớp cũng bị chặn ở đây.
 */
const assumptionPathErrors = (spine: Spine, ops: readonly unknown[], stepId: string | null): ValidationError[] => {
  const parsed = ops.flatMap((raw, index) => {
    const op = userOpSchema.safeParse(raw)
    return op.success ? [{ op: op.data, index }] : []
  })
  const errors: ValidationError[] = []
  for (const assumption of spine.assumptions) {
    // Câu bị viết lại ở BẤT KỲ trạng thái nào: để `unconfirmed` hay bỏ op status cũng không được để Spine và giả định lệch nhau
    const restated = parsed.find(({ op }) => {
      if (op.op !== "set") return false
      const field = ASSUMPTION_STATEMENT_PATH.exec(op.path)
      if (field?.[1] === assumption.id) {
        const current = field[2] === "statement" ? assumption.statement : assumption.statement_vi
        return typeof op.value === "string" && restatedText(op.value, current)
      }
      const whole = ASSUMPTION_PATH.exec(op.path)
      if (whole?.[1] !== assumption.id || !isRecord(op.value)) return false
      return (
        restatedText(op.value.statement, assumption.statement) ||
        (typeof op.value.statement_vi === "string" && restatedText(op.value.statement_vi, assumption.statement_vi))
      )
    })
    if (!restated) continue
    const newPaths = parsed.flatMap(({ op }) => (op.op === "set" && op.path === `assumptions[id=${assumption.id}].path` && typeof op.value === "string" ? [op.value] : []))
    const targets = [assumption.path, ...newPaths]
    const wroteField =
      parsed.some(({ op }) => !op.path.startsWith("assumptions") && targets.some((target) => pathsRelated(op.path, target))) ||
      (isBriefPhase(stepId) && wroteBriefCoreEntry(spine, parsed, assumption.path))
    if (!wroteField) {
      errors.push({
        rule: "assumption_path_mismatch",
        op_index: restated.index,
        path: restated.op.path,
        message: `Bạn đổi câu của ${assumption.id} nhưng không ghi trường thật mà nó nói về ("${assumption.path}"). Lô phải có op set đúng path đó với giá trị mới, cùng lúc với statement và status.`
      })
    }
  }
  return errors
}

/**
 * Chuẩn hoá op của MODEL (không áp cho lô user gửi qua `/changes`). Không thêm/bớt op ở giữa lô — `op_index`
 * của lỗi phải còn trỏ đúng lô model đã gửi (chỉ được nối thêm ở cuối).
 * - `add screens[]` ⇒ `detail_status: "pending"`; `set screens[id=X]` cả phần tử ⇒ giữ `detail_status` hiện tại;
 *   `set screens[].detail_status` ⇒ lỗi (BUG-03: model tự để trống màn Auth/Admin mà không hỏi user).
 * - `confirmed_at` luôn do server đặt (BUG-29: model bịa ngày xác nhận): `add assumptions[]` ⇒ `unconfirmed`/`null`;
 *   `set …confirmed_at` ⇒ thay bằng giá trị server; `set status = confirmed` ở step rà giả định ⇒ server đặt ngày.
 * - `status` của giả định chỉ đổi được ở `ASSUMPTION_SWEEP_STEPS`.
 * - `add addendum[]` ⇒ `captured_at` là giờ server (`stampAddendum`), không phải ngày model viết.
 */
export const sanitizeModelOps = (
  spine: Spine,
  ops: unknown,
  stepId: string | null = null,
  now: Date = new Date(),
  options: SanitizeOptions = {}
): SanitizeResult => {
  if (!Array.isArray(ops)) return { ops: [], errors: [] }
  const base = stepId ? stepId.split("@")[0] : ""
  const sweepStep = ASSUMPTION_SWEEP_STEPS.has(base) && (!USER_DECISION_SWEEP_STEPS.has(base) || options.userDecided === true || options.revision === true)
  // Revision ở cổng chỉ đổi status của giả định cổng vừa nói; bước rà giả định đổi được mọi giả định
  const canSetStatus = (id: string): boolean => sweepStep || (options.revision === true && (options.gateAssumptionIds?.has(id) ?? false))
  const errors: ValidationError[] = []
  const at = now.toISOString()

  // status giả định sau lô (để suy ra confirmed_at đúng)
  const statusAfter = new Map<string, string>(spine.assumptions.map((a) => [a.id, a.status]))
  for (const raw of ops) {
    const op = userOpSchema.safeParse(raw)
    if (!op.success || op.data.op !== "set") continue
    const field = ASSUMPTION_FIELD_PATH.exec(op.data.path)
    if (field && field[2] === "status" && typeof op.data.value === "string" && canSetStatus(field[1])) statusAfter.set(field[1], op.data.value)
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
      // Ngoài phạm vi được đổi status: giữ nguyên status hiện tại thay vì làm hỏng cả lô. Model hay tự "xác nhận" giả định
      // khi user vừa đồng ý trong chat — 3 lượt thử đều bị từ chối thì cả bước thất bại (gặp thật ở B-1.6). Việc xác nhận
      // thuộc về user ở cổng duyệt (chip "Đúng rồi, đi tiếp") hoặc bước rà giả định.
      if (!canSetStatus(field[1])) {
        const current = spine.assumptions.find((a) => a.id === field[1])
        return { ...op, value: current?.status ?? "unconfirmed" }
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
    if (op.op === "set") {
      const badEnum = invalidProjectEnum(op.path, op.value)
      if (badEnum) {
        errors.push({
          rule: "op_not_allowed",
          op_index: index,
          path: op.path,
          message: `project.${badEnum} chỉ nhận một trong: ${PROJECT_ENUM_VALUES[badEnum].join(", ")}. Nhiều nền tảng ⇒ chọn nền tảng chính, ghi các nền tảng còn lại vào addendum.`
        })
        return op
      }
    }
    if (op.op === "add" && op.path === "assumptions[]" && isRecord(op.value)) {
      // Giả định đã có (kể cả đã xác nhận) — thêm lại là bắt user xác nhận lần nữa điều họ vừa chốt
      const keys = [assumptionKey(op.value.statement), assumptionKey(op.value.statement_vi)].filter((k) => k !== "")
      const same = spine.assumptions.find((a) => keys.includes(assumptionKey(a.statement)) || keys.includes(assumptionKey(a.statement_vi)))
      if (same) {
        errors.push({
          rule: "op_not_allowed",
          op_index: index,
          path: op.path,
          message: `Giả định này đã có (${same.id}, ${same.status}) — không thêm lại. Điều user đã nói hoặc đã xác nhận là sự thật, không phải giả định mới.`
        })
        return op
      }
      return { ...op, value: { ...op.value, path: normalizeSelectorPath(op.value.path), status: "unconfirmed", confirmed_at: null } }
    }
    if (op.op === "set" && /^assumptions\[id=[^\]]+\]\.path$/.test(op.path)) {
      return { ...op, value: normalizeSelectorPath(op.value) }
    }
    if (op.op === "set" && isRecord(op.value)) {
      const screenId = /^screens\[id=([^\]]+)\]$/.exec(op.path)?.[1]
      const screen = screenId ? spine.screens.find((s) => s.id === screenId) : undefined
      if (screen) return { ...op, value: { ...op.value, detail_status: screen.detail_status } }
      const assumptionId = ASSUMPTION_PATH.exec(op.path)?.[1]
      const assumption = assumptionId ? spine.assumptions.find((a) => a.id === assumptionId) : undefined
      if (assumption && assumptionId) {
        confirmedAtWritten.add(assumptionId)
        const status = canSetStatus(assumptionId) && typeof op.value.status === "string" ? op.value.status : assumption.status
        return { ...op, value: { ...op.value, status, confirmed_at: canSetStatus(assumptionId) ? confirmedAtFor(assumptionId) : assumption.confirmed_at } }
      }
    }
    return op
  })

  // status đổi ở step rà giả định mà lô không kèm confirmed_at ⇒ nối thêm op đặt ngày (ở cuối — không lệch op_index)
  if (sweepStep || options.revision) {
    for (const a of spine.assumptions) {
      if (!canSetStatus(a.id) || confirmedAtWritten.has(a.id) || statusAfter.get(a.id) === a.status) continue
      const value = confirmedAtFor(a.id)
      if (value !== a.confirmed_at) out.push({ op: "set", path: `assumptions[id=${a.id}].confirmed_at`, value, reason: "confirmed_at do server đặt" })
    }
  }
  if (options.revision) errors.push(...assumptionPathErrors(spine, out, stepId))
  return { ops: stampAddendum(out, now), errors }
}

/** Tên màn hình / thành phần kỹ thuật — entity là dữ liệu được lưu, không phải nơi hiển thị hay xử lý nó. */
const ENTITY_NAME_FORBIDDEN = /\b(list|screen|page|form|popup|modal|dialog|service|manager|controller|dto|table)$/i

/**
 * Động từ bị động hoặc đọc con → cha: `belongs to`, `is part of`, `owned by`, `assigned to`, `derived from`,
 * `contained in`, `applies to`… (`replies to` của cây tự thân, `consists of`, `appears in` vẫn hợp lệ).
 */
const PASSIVE_VERB =
  /^(is|are|was|were|be|been|being)\b|^belong(s|ing)?\b|^part of$|\bby$|^\w+ed (to|from|in|into|with|under|for)$|^(applies|refers|points|comes|relates|links|reports) (to|from)$/

const escapeRe = (text: string): string => text.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
/** Tên entity dạng regex (khớp cả số nhiều, không phân biệt hoa thường). */
const nameRe = (name: string): RegExp => new RegExp(`\\b${escapeRe(name)}(s|es)?\\b`, "i")
/** Danh từ chính của tên ("Exam Attempt" ⇒ "Attempt") — câu giả định hay viết tắt "the attempt". */
const headNoun = (name: string): string => name.trim().split(/\s+/).pop() ?? name

/**
 * Vòng trong đồ thị cha → con (bỏ quan hệ tự thân, bỏ cặp hai chiều — đã báo `erd_many_to_many`). Tarjan
 * SCC: mỗi thành phần liên thông mạnh ≥ 3 entity là một vòng, trả theo thứ tự id.
 */
const relationCycles = (spine: Spine): string[][] => {
  const ids = new Set(spine.entities.map((e) => e.id))
  const edges = new Map(spine.entities.map((e) => [e.id, [...new Set(e.relations)].filter((t) => t !== e.id && ids.has(t)).sort()]))
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  let counter = 0
  const visit = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter++)
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v)!) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) !== index.get(v)) return
    const component: string[] = []
    let w: string
    do {
      w = stack.pop()!
      onStack.delete(w)
      component.push(w)
    } while (w !== v)
    if (component.length >= 3) out.push(component.sort())
  }
  for (const id of [...ids].sort()) if (!index.has(id)) visit(id)
  return out
}

/**
 * Luật ERD áp lúc SINH (skill `entities-erd`): chạy trên Spine SAU lô. Cờ `orphan_entity` /
 * `unresolved_many_to_many` vẫn giữ làm lưới cho dữ liệu vào đường khác (import, sửa qua chat).
 */
export const erdShapeErrors = (after: Spine): ValidationError[] => {
  const errors: ValidationError[] = []
  const names = new Map(after.entities.map((e) => [e.id, e.name]))

  const byName = new Map<string, string[]>()
  for (const e of after.entities) {
    const key = e.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    byName.set(key, [...(byName.get(key) ?? []), e.id])
    if (ENTITY_NAME_FORBIDDEN.test(e.name.trim())) {
      errors.push({ rule: "erd_entity_name_invalid", path: `entities[id=${e.id}].name`, message: `"${e.name}" là tên màn hình/thành phần kỹ thuật, không phải thứ được lưu — đặt tên theo dữ liệu (vd "Exam List" ⇒ "Exam")` })
    }
    for (const [target, verb] of Object.entries(e.relation_verbs ?? {})) {
      if (PASSIVE_VERB.test(verb.trim())) {
        errors.push({
          rule: "erd_relation_verb_passive",
          path: `entities[id=${e.id}].relation_verbs`,
          message: `"${e.name} ${verb} ${names.get(target) ?? target}" bị động hoặc đọc con → cha — GIỮ chiều quan hệ đã chọn bằng hai câu hỏi bản số, chỉ viết lại động từ ở thể chủ động từ phía cha (vd "Score Record receives Regrade Appeal"); không đảo chiều chỉ để hợp động từ`
        })
      }
    }
  }
  for (const ids of byName.values()) {
    if (ids.length > 1) errors.push({ rule: "erd_duplicate_name", path: "entities", message: `Trùng tên entity "${names.get(ids[0])}": ${ids.join(", ")} — gộp thành một` })
  }
  // Mô tả nhắc đúng tên (số ít/nhiều) entity khác ⇒ hai entity phải nối trực tiếp hoặc có chung một con (entity
  // trung gian như Seat Assignment giữa Room và Slot). Bắt "registration for one exam slot" mà không có Slot → Registration.
  const neighbours = new Map(after.entities.map((e) => [e.id, new Set<string>()]))
  const children = new Map(after.entities.map((e) => [e.id, new Set(e.relations)]))
  for (const e of after.entities) {
    for (const t of e.relations) {
      if (!neighbours.has(t)) continue
      neighbours.get(e.id)!.add(t)
      neighbours.get(t)!.add(e.id)
    }
  }
  const sharesChild = (a: string, b: string) => [...children.get(a)!].some((c) => children.get(b)!.has(c))
  // Tổ tiên (nối qua chuỗi cha → con) cũng tính là đã liên kết — khớp luật "không quan hệ tắt": Swap Request nhắc
  // "user" thì User → Invigilator Assignment → Swap Request là đủ, không được đòi thêm cạnh tắt User → Swap Request
  const isAncestor = (ancestor: string, of: string): boolean => {
    const seen = new Set<string>()
    const stack = [ancestor]
    while (stack.length > 0) {
      for (const c of children.get(stack.pop()!) ?? []) {
        if (c === of) return true
        if (!seen.has(c) && children.has(c)) {
          seen.add(c)
          stack.push(c)
        }
      }
    }
    return false
  }
  for (const e of after.entities) {
    const unlinked = after.entities.filter((other) => {
      if (other.id === e.id || neighbours.get(e.id)!.has(other.id) || sharesChild(e.id, other.id) || isAncestor(other.id, e.id)) return false
      return nameRe(other.name).test(e.description)
    })
    if (unlinked.length > 0) {
      errors.push({
        rule: "erd_description_unlinked",
        path: `entities[id=${e.id}].description`,
        message: `Mô tả của "${e.name}" nhắc tới ${unlinked.map((o) => `"${o.name}"`).join(", ")} nhưng không có quan hệ trực tiếp, không qua chuỗi cha → con, cũng không chung entity trung gian — thêm quan hệ theo hai câu hỏi bản số, hoặc viết lại mô tả đúng thứ được lưu`
      })
    }
  }
  // Bản số "1" phải có bằng chứng: giả định ở `entities[id=<cha>].relation_cardinality` nhắc tên entity con, và giả
  // định chưa xác nhận phải dẫn id nguồn (FN/BR/UC/AS). Mặc định an toàn là N — "1" không được đoán.
  const cardinalityAssumptions = (entityId: string) =>
    after.assumptions.filter((a) => a.path === `entities[id=${entityId}].relation_cardinality`)
  for (const e of after.entities) {
    const ones = Object.entries(e.relation_cardinality ?? {}).filter(([t, c]) => c === "1" && names.has(t))
    if (ones.length === 0) continue
    const statements = cardinalityAssumptions(e.id).map((a) => a.statement)
    const unjustified = ones.filter(([t]) => !statements.some((st) => nameRe(names.get(t)!).test(st)))
    if (unjustified.length > 0) {
      errors.push({
        rule: "erd_cardinality_unjustified",
        path: `entities[id=${e.id}].relation_cardinality`,
        message: `"${e.name}" đánh dấu một–một với ${unjustified.map(([t]) => `"${names.get(t)}"`).join(", ")} nhưng không có giả định ở entities[id=${e.id}].relation_cardinality nêu tên entity con — thêm giả định dẫn bằng chứng (FN/BR/UC/AS), hoặc bỏ "1" (mặc định N)`
      })
    }
  }
  for (const a of after.assumptions) {
    if (a.status === "confirmed" || !/^entities\[id=[^\]]+\]\.relation_cardinality$/.test(a.path)) continue
    if (!/\b(FN|BR|UC|AS)\d+\b/.test(a.rationale ?? "")) {
      errors.push({
        rule: "erd_cardinality_no_evidence",
        path: `assumptions[id=${a.id}].rationale`,
        message: `Giả định ${a.id} về bản số không dẫn id bằng chứng nào — rationale phải nêu FN/BR/UC/AS cụ thể (vd "BR55: tối đa một đơn phúc khảo mỗi lượt thi"); không có bằng chứng thì để N`
      })
    }
  }
  // Giả định nói một–một mà entity không đánh dấu ⇒ ERD vẫn vẽ N, giả định và hình mâu thuẫn nhau
  for (const a of after.assumptions) {
    const m = /^entities\[id=([^\]]+)\]\.relation_cardinality$/.exec(a.path)
    const target = m ? after.entities.find((e) => e.id === m[1]) : undefined
    if (target && Object.keys(target.relation_cardinality ?? {}).length === 0) {
      errors.push({
        rule: "erd_cardinality_unset",
        path: `entities[id=${target.id}].relation_cardinality`,
        message: `Giả định ${a.id} nói về bản số của "${target.name}" nhưng entity không đặt relation_cardinality — ghi {"<id con>": "1"} cho quan hệ một–một`
      })
    }
  }
  // Entity không có cha phải được khai là gốc (`root: true` — dữ liệu chủ tồn tại độc lập). Entity phụ thuộc trôi nổi
  // (Exam Paper chỉ nối qua con Paper Question) là lỗi hay gặp nhất khi model bỏ Pass 2.
  if (after.entities.length > 1) {
    const hasParent = new Set(after.entities.flatMap((e) => e.relations.filter((t) => t !== e.id)))
    for (const e of after.entities) {
      if (hasParent.has(e.id) || e.root === true) continue
      errors.push({
        rule: "erd_dependent_without_parent",
        path: `entities[id=${e.id}]`,
        message: `"${e.name}" không có cha nhưng không khai root — nếu là dữ liệu chủ tồn tại độc lập (User, Course, Room…) đặt "root": true; nếu phụ thuộc thì thêm cha mà mô tả của nó nói "of/for/in/against"`
      })
    }
  }
  // Giả định bản số dựa vào "one <con>" của một quan hệ KHÁC mà quan hệ đó vẫn vẽ N ⇒ ERD tự mâu thuẫn
  // (AS75: "an attempt produces one score record" trong khi Exam Attempt → Score Record là N).
  for (const a of after.assumptions) {
    if (!/^entities\[id=[^\]]+\]\.relation_cardinality$/.test(a.path)) continue
    const text = `${a.statement} ${a.rationale ?? ""}`
    for (const parent of after.entities) {
      for (const child of new Set(parent.relations)) {
        const childName = names.get(child)
        if (!childName || child === parent.id || parent.relation_cardinality?.[child] === "1") continue
        const claimsOne = new RegExp(`\\b(one|exactly one|a single|only one|at most one)\\s+${escapeRe(childName)}\\b`, "i").test(text)
        const namesParent = nameRe(parent.name).test(text) || nameRe(headNoun(parent.name)).test(text)
        if (claimsOne && namesParent) {
          errors.push({
            rule: "erd_cardinality_contradiction",
            path: `entities[id=${parent.id}].relation_cardinality`,
            message: `Giả định ${a.id} dựa vào "một ${childName} cho mỗi ${parent.name}" nhưng quan hệ "${parent.name}" → "${childName}" đang là N — đặt "1" kèm giả định dẫn bằng chứng riêng, hoặc sửa lập luận của ${a.id}`
          })
        }
      }
    }
  }
  // Giả định ĐÃ XÁC NHẬN nói nhiều–nhiều giữa đúng hai entity ("many papers … many questions") mà ERD nối thẳng hai
  // entity đó ⇒ bỏ mất entity trung gian, trái quyết định của user.
  for (const a of after.assumptions) {
    if (a.status !== "confirmed" || (a.statement.match(/\bmany\b/gi) ?? []).length < 2) continue
    const mentioned = after.entities.filter((e) => nameRe(e.name).test(a.statement))
    if (mentioned.length !== 2) continue
    const [x, y] = mentioned
    if (x.relations.includes(y.id) || y.relations.includes(x.id)) {
      errors.push({
        rule: "erd_confirmed_many_to_many",
        path: `entities[id=${x.relations.includes(y.id) ? x.id : y.id}].relations`,
        message: `Giả định đã xác nhận ${a.id} nói "${x.name}" và "${y.name}" là nhiều–nhiều nhưng ERD nối thẳng hai entity — thêm entity trung gian làm con của cả hai`
      })
    }
  }
  for (const cycle of relationCycles(after)) {
    errors.push({
      rule: "erd_relation_cycle",
      path: "entities",
      message: `Chuỗi cha–con khép vòng giữa ${cycle.map((id) => `"${names.get(id)}"`).join(", ")} — có quan hệ sai chiều, xét lại bằng hai câu hỏi bản số`
    })
  }
  const orphans = orphanEntities(after)
  if (orphans.length > 0) {
    errors.push({
      rule: "erd_disconnected",
      path: "entities",
      message: `ERD phải là một khối liên thông. Nối các entity sau vào phần còn lại (hoặc bỏ nếu không thuộc sản phẩm): ${orphans
        .map(({ entity, why }) => `${entity.id} "${entity.name}" ${why}`)
        .join("; ")}`
    })
  }
  for (const e of after.entities) {
    const path = `entities[id=${e.id}].relation_verbs`
    const verbs = e.relation_verbs ?? {}
    const missing = [...new Set(e.relations)].filter((t) => names.has(t) && !verbs[t]?.trim())
    if (missing.length > 0) {
      errors.push({ rule: "erd_relation_verb_missing", path, message: `"${e.name}" thiếu động từ cho quan hệ tới ${missing.join(", ")} — thêm key vào relation_verbs` })
    }
    const extra = [...Object.keys(verbs), ...Object.keys(e.relation_cardinality ?? {}), ...(e.relation_optional ?? [])].filter((t) => !e.relations.includes(t))
    if (extra.length > 0) {
      errors.push({ rule: "erd_relation_verb_extra", path, message: `"${e.name}" có relation_verbs/relation_cardinality/relation_optional cho ${[...new Set(extra)].join(", ")} nhưng id đó không nằm trong relations` })
    }
    const mutual = [...new Set(e.relations)].filter((t) => t > e.id && after.entities.find((x) => x.id === t)?.relations.includes(e.id))
    for (const t of mutual) {
      errors.push({
        rule: "erd_many_to_many",
        path: `entities[id=${e.id}].relations`,
        message: `"${e.name}" và "${names.get(t)}" trỏ lẫn nhau — tách quan hệ nhiều–nhiều thành entity trung gian`
      })
    }
  }
  return errors
}

/**
 * Lô đụng ERD: ghi `entities`, hoặc ghi/xoá một giả định trỏ vào entity (xoá giả định đang làm bằng chứng cho "1"
 * cũng phải bị soi). Giả định của step khác không trỏ entity ⇒ không soi, để Spine cũ chưa đủ luật ERD vẫn chạy được.
 */
const touchesErd = (spine: Spine, ops: readonly Op[]): boolean =>
  ops.some((op) => {
    if (op.path === "entities" || op.path.startsWith("entities[")) return true
    if (!op.path.startsWith("assumptions")) return false
    if (JSON.stringify(op.value ?? null).includes("entities[")) return true
    const id = /^assumptions\[id=([^\]]+)\]/.exec(op.path)?.[1]
    return id !== undefined && (spine.assumptions.find((a) => a.id === id)?.path ?? "").startsWith("entities[")
  })

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
    // Chạy trước check `writable`: B-1.1…B-2.2 không có project.vision trong writes, nhưng model cần đúng hướng dẫn "ghi addendum"
    if (isBriefPhase(options.stepId) && writesProjectVisionOrGoals(op.data, spine)) {
      errors.push({ rule: "path_not_writable", op_index: index, path: op.data.path, message: BRIEF_PROJECT_WRITE_MESSAGE })
      return
    }
    if (options.writable && !isWritablePath(op.data.path, options.writable) && !isExtraPath(op.data.path, options.extraPaths)) {
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

  if (options.stepId === BRIEF_EXTRACTION_STEP) {
    const outOfScope = briefCoreScopeErrors(spine, parsed)
    if (outOfScope.length > 0) return outOfScope
  }

  if (options.visibleIds) {
    const outOfScope = scopeErrors(spine, parsed, options.visibleIds, options.stepId, options.extraPaths)
    if (outOfScope.length > 0) return outOfScope
  }

  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops: parsed, by: "op-validator", step_id: options.stepId ?? null }, { startSeq: 1 })
    return touchesErd(spine, parsed) ? erdShapeErrors(plan.spine) : []
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
