/**
 * change.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Sửa SRS **qua hội thoại** (Phases §2.2–2.3, srs-spine.md §9). Document pane read-only; mọi thay đổi
 * đi qua đây, dù user gõ câu lệnh tự nhiên (`instruction`) hay UI gửi lô op sẵn (`ops`).
 *
 * Ba nhánh theo impact (UC 6.1, 6.2, 6.8):
 *   silent         không khoá nào trỏ tới, không section nào đọc ⇒ áp luôn, chỉ ghi `changes[]`
 *   dependent      có phụ thuộc ⇒ phải xem preview diff + phạm vi trước khi áp
 *   post_baseline  đã có baseline ⇒ Impact Analysis bắt buộc, `reason` bắt buộc (vào §I Record of Changes)
 *
 * KHÔNG tự lan toả: áp xong chỉ làm section phụ thuộc thành `stale` (hàm tính của T09), việc viết lại
 * nội dung là hoà giải thủ công một lượt (`reconcile.service.ts`).
 *
 * Model chỉ sinh op — `apply-change-op/SKILL.md`. Lệnh mơ hồ ⇒ `clarification` (UC 6.11), không đoán bừa.
 */

import { randomUUID } from "node:crypto"
import { TransactionRejectedError, applyTransaction, planTransaction } from "./op-engine.js"
import * as repository from "./spine.repository.js"
import { impactOfChanges, type Impact } from "./impact.service.js"
import * as flagsService from "./flags.service.js"
import { OP_INVALID, type ApplyResult, type Op, type PreviewResult, type Transaction, type Violation } from "./op.types.js"
import { PathError, parsePath } from "./path-resolver.js"
import type { Spine, SpineRecord } from "./spine.types.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { ChangeInstructionOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION"
/**
 * `preview_id` không còn hiệu lực (hết hạn, đã dùng, hoặc của project khác). Dùng lại mã đã có trong
 * hợp đồng §0.3 thay vì thêm mã mới — mock FE (T16) cũng đã trả đúng mã này cho tình huống này.
 * Tên mã hơi lệch nghĩa; ghi ở `docs/spec-gaps.md`.
 */
export const PREVIEW_EXPIRED = "CHANGE_RANGE_INVALID"

/** Lệnh mơ hồ (UC 6.11) — 409, câu hỏi làm rõ đi trong `meta.clarification`. */
export class NeedsClarificationError extends ApiError {
  readonly clarification: string

  constructor(clarification: string) {
    super(409, clarification, NEEDS_CLARIFICATION)
    this.clarification = clarification
  }
}

/**
 * Gốc path do hệ thống quản lý — user không sửa trực tiếp qua `/changes`:
 * cờ đi qua `/flags` (waive/recompute), step/progress qua step runner và gate, baseline qua `/baseline`,
 * section và diagram do engine/render ghi.
 */
export const SYSTEM_MANAGED_ROOTS: ReadonlySet<string> = new Set(["flags", "steps", "progress", "baselines", "sections", "diagrams"])

export const notWritableViolations = (ops: readonly Op[]): Violation[] =>
  ops.flatMap((op, index): Violation[] => {
    let root: string
    try {
      root = parsePath(op.path)[0].key
    } catch (err) {
      // Path sai cú pháp: để engine báo path_invalid kèm op_index
      if (err instanceof PathError) return []
      throw err
    }
    if (!SYSTEM_MANAGED_ROOTS.has(root)) return []
    return [{ rule: "path_not_writable", path: op.path, op_index: index, message: `"${root}" do hệ thống quản lý, không sửa trực tiếp qua /changes` }]
  })

// ─── nhánh ───────────────────────────────────────────────────────

export type ChangeBranch = "silent" | "dependent" | "post_baseline"

/**
 * Nhánh xử lý của một lô. `post_baseline` thắng mọi thứ: sau khi đã chốt baseline thì kể cả sửa một
 * field không ai đọc cũng phải có lý do và phải thấy phạm vi (UC 6.8).
 */
export const branchOf = (spine: Pick<Spine, "baselines">, impact: Impact): ChangeBranch => {
  if (spine.baselines.length > 0) return "post_baseline"
  const hasDependents =
    impact.referrers.length > 0 ||
    impact.diagrams.length > 0 ||
    impact.sections.some((s) => s.relation !== "owner")
  return hasDependents ? "dependent" : "silent"
}

// ─── kho preview đã tính (preview → confirm → apply) ──────────────

interface StoredPreview {
  projectId: string
  base_version: number
  ops: Op[]
  reason: string | null
  impact: Impact
  branch: ChangeBranch
  expires_at: number
}

/** Preview chỉ sống đủ lâu để user đọc diff rồi bấm xác nhận. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_STORED_PREVIEWS = 500

const previewStore = new Map<string, StoredPreview>()

const prunePreviews = (now: number): void => {
  for (const [id, stored] of previewStore) if (stored.expires_at <= now) previewStore.delete(id)
  while (previewStore.size > MAX_STORED_PREVIEWS) {
    const oldest = previewStore.keys().next()
    if (oldest.done) break
    previewStore.delete(oldest.value)
  }
}

/** Test dùng để cô lập giữa các ca. */
export const clearPreviewStore = (): void => previewStore.clear()

const takePreview = (projectId: string, previewId: string): StoredPreview => {
  prunePreviews(Date.now())
  const stored = previewStore.get(previewId)
  if (!stored || stored.projectId !== projectId) {
    throw new ApiError(422, "Bản xem trước đã hết hạn — hãy xem lại thay đổi rồi xác nhận", PREVIEW_EXPIRED)
  }
  previewStore.delete(previewId)
  return stored
}

// ─── projection quanh thực thể được nhắc ─────────────────────────

/** Collection có thể là mục tiêu của một câu lệnh sửa (không gồm gốc hệ thống quản lý). */
const TARGET_COLLECTIONS = [
  "actors",
  "roles",
  "use_cases",
  "features",
  "screens",
  "functions",
  "entities",
  "nfrs",
  "business_rules",
  "common_requirements",
  "messages",
  "other_requirements",
  "glossary"
] as const

/** Số phần tử tối đa đưa vào prompt — không nạp cả Spine (coding-rules mục 3.6). */
export const PROJECTION_ELEMENT_LIMIT = 40
const MIN_NAME_MATCH = 3

const textOf = (element: Record<string, unknown>): string =>
  [element.name, element.term, element.statement, element.code].filter((v): v is string => typeof v === "string").join(" ")

/**
 * Chỉ những phần tử câu lệnh THẬT SỰ nhắc tới (trùng id, hoặc tên/từ khoá xuất hiện trong câu).
 * Không nhắc ai rõ ràng ⇒ đưa chỉ mục gọn (id + nhãn) để model tự định vị, vẫn không phải cả Spine.
 */
export const buildChangeProjection = (spine: Spine, instruction: string): Record<string, unknown> => {
  const haystack = instruction.toLowerCase()
  const projection: Record<string, unknown> = {}
  let matched = 0
  // FLF-200 (BUG-08): model phải thấy id nào ĐANG tồn tại, nếu không nó đoán `UC18`, `UC-REMIND` rồi lô
  // op chết vì `path_not_resolved` hoặc `duplicate_id`. Id mới thì server cấp — model bỏ trống `id`.
  const existingIds: Record<string, string[]> = {}
  for (const collection of TARGET_COLLECTIONS) {
    const list = spine[collection] as unknown as { id?: unknown }[]
    if (!Array.isArray(list) || list.length === 0) continue
    existingIds[collection] = list.map((el) => String(el.id)).slice(0, 200)
  }

  for (const collection of TARGET_COLLECTIONS) {
    const list = spine[collection] as unknown as Record<string, unknown>[]
    if (!Array.isArray(list)) continue
    const hits = list.filter((element) => {
      const id = String(element.id ?? "")
      if (id.length > 0 && haystack.includes(id.toLowerCase())) return true
      const label = textOf(element)
      return label.length >= MIN_NAME_MATCH && haystack.includes(label.toLowerCase())
    })
    if (hits.length === 0) continue
    projection[collection] = hits.slice(0, PROJECTION_ELEMENT_LIMIT)
    matched += hits.length
  }

  if (matched > 0) return { ...projection, existing_ids: existingIds }

  const index: Record<string, unknown> = {}
  for (const collection of TARGET_COLLECTIONS) {
    const list = spine[collection] as unknown as Record<string, unknown>[]
    if (!Array.isArray(list) || list.length === 0) continue
    index[collection] = list.slice(0, PROJECTION_ELEMENT_LIMIT).map((element) => ({ id: element.id, label: textOf(element) }))
  }
  return { ...index, existing_ids: existingIds }
}

// ─── nhận diện lệnh sửa trong chat thường ────────────────────────

/**
 * Động từ mở đầu một lệnh sửa, tiếng Việt và tiếng Anh. Cố ý HẸP: chỉ nhận khi động từ đứng gần đầu
 * câu và câu không phải câu hỏi — session không pipeline vẫn chủ yếu để hỏi đáp, nhận nhầm một câu hỏi
 * thành lệnh sửa gây tốn credit và làm user hoảng.
 */
const CHANGE_VERBS: readonly string[] = Object.freeze([
  "đổi",
  "thay",
  "sửa",
  "chỉnh",
  "thêm",
  "bổ",
  "xoá",
  "xóa",
  "loại",
  "bỏ",
  "cập",
  "gộp",
  "tách",
  "add",
  "change",
  "delete",
  "fix",
  "merge",
  "remove",
  "rename",
  "replace",
  "set",
  "split",
  "update"
])

/** Dấu hiệu câu hỏi — không coi là lệnh sửa dù có động từ. */
const QUESTION_MARKERS: readonly string[] = Object.freeze(["?", "là gì", "tại sao", "thế nào", "có nên", "vì sao", "what", "why", "how"])

/** Số từ đầu câu được xét — "đổi tên actor A01" nhận, "tôi nghĩ là nên đổi" thì không. */
export const CHANGE_VERB_WINDOW = 4

/**
 * Tin nhắn ở session KHÔNG pipeline có phải lệnh sửa SRS không (Phases §2.3: mọi sửa đổi đi qua
 * change flow, kể cả gõ từ một session hỏi đáp). Không nhận ⇒ vẫn là CHAT thường.
 */
export const isChangeInstruction = (message: string): boolean => {
  const text = message.trim().toLowerCase()
  if (text.length === 0) return false
  if (QUESTION_MARKERS.some((marker) => text.includes(marker))) return false
  return text.split(/\s+/).slice(0, CHANGE_VERB_WINDOW).some((word) => CHANGE_VERBS.includes(word.replace(/[^\p{L}]/gu, "")))
}

// ─── dependency injection (mock provider trong test) ─────────────

export type ChangeExecutor = (
  actionType: ActionType,
  input: AiActionInput,
  projectId: string,
  userId: string
) => Promise<AiActionResult<ChangeInstructionOutput>>

export interface ChangeDeps {
  /** Mặc định gọi model thật qua `executeAiAction` (T04 lo reserve/deduct credit). */
  changeExecutor: ChangeExecutor
  /** Chạy lại deterministic check sau khi ghi (T09). */
  recomputeFlags: (projectId: string, userId: string) => Promise<unknown>
}

export const defaultChangeDeps = (): ChangeDeps => ({
  changeExecutor: (actionType, input, projectId, userId) => executeAiAction<ChangeInstructionOutput>(actionType, input, projectId, userId),
  recomputeFlags: (projectId, userId) => flagsService.recompute(projectId, { by: userId })
})

// ─── body ────────────────────────────────────────────────────────

export interface ChangeBody {
  base_version: number
  ops?: Op[]
  instruction?: string
  reason?: string
  preview_id?: string
}

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const loadSpine = async (projectId: string, init: repository.SpineInit): Promise<SpineRecord> =>
  (await repository.get(projectId)) ?? { projectId, ...repository.createEmptySpine(init) }

const assertVersion = (record: SpineRecord, baseVersion: number): void => {
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
}

interface ResolvedOps {
  ops: Op[]
  clarification: string | null
  /** Ghi chú ngắn model trả về, hiện trên thẻ preview. */
  notes: string | null
}

/** Câu lệnh tự nhiên → lô op, hoặc một câu hỏi làm rõ (UC 6.11). Một lượt gọi model, không retry. */
const opsFromInstruction = async (
  projectId: string,
  userId: string,
  spine: Spine,
  instruction: string,
  deps: ChangeDeps
): Promise<ResolvedOps> => {
  const result = await deps.changeExecutor(
    ActionType.CHANGE_INSTRUCTION,
    {
      promptVariables: {
        call_kind: "change_instruction",
        user_message: instruction,
        is_pipeline: false,
        has_baseline: spine.baselines.length > 0,
        projection: buildChangeProjection(spine, instruction),
        glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
        stale_sections: []
      }
    },
    projectId,
    userId
  )

  const clarification = result.data.clarification_needed?.trim()
  if (clarification) return { ops: [], clarification, notes: null }
  return { ops: (result.data.ops ?? []) as Op[], clarification: null, notes: result.data.notes ?? null }
}

const resolveOps = async (
  projectId: string,
  userId: string,
  spine: Spine,
  body: ChangeBody,
  deps: ChangeDeps
): Promise<ResolvedOps> => {
  if (body.ops !== undefined) return { ops: body.ops, clarification: null, notes: null }
  if (body.instruction === undefined) throw new ApiError(400, "Cần ops hoặc instruction", "VALIDATION_ERROR")
  return await opsFromInstruction(projectId, userId, spine, body.instruction, deps)
}

const toTransaction = (userId: string, body: ChangeBody, ops: Op[], txn?: string): Transaction => ({
  ...(txn === undefined ? {} : { txn }),
  base_version: body.base_version,
  ops,
  by: userId,
  step_id: null,
  ...(body.reason === undefined ? {} : { reason: body.reason })
})

export interface ChangePreviewResult extends PreviewResult {
  branch?: ChangeBranch
  impact?: Impact
  clarification?: string
  preview_id?: string
  notes?: string
  /** Hoà giải: section vẫn đúng nội dung, user chỉ cần xác nhận nguyên trạng (BUG-16). */
  no_change?: boolean
}

const rejectedPreview = (baseVersion: number, violations: Violation[], referrers: PreviewResult["referrers"] = []): ChangePreviewResult => ({
  ok: false,
  txn: randomUUID(),
  base_version: baseVersion,
  ops: [],
  changes: [],
  violations,
  referrers
})

/**
 * Diff đầy đủ (gồm op cascade) + phạm vi ảnh hưởng, KHÔNG ghi gì. Project chưa có Spine thì preview
 * trên Spine rỗng — preview không được tạo Spine (hợp đồng §1, T08).
 */
export const preview = async (
  projectId: string,
  userId: string,
  body: ChangeBody,
  init: repository.SpineInit = {},
  deps: Partial<ChangeDeps> = {}
): Promise<ChangePreviewResult> => {
  const d: ChangeDeps = { ...defaultChangeDeps(), ...deps }
  const record = await loadSpine(projectId, init)
  assertVersion(record, body.base_version)
  const spine = stripRecord(record)

  const resolved = await resolveOps(projectId, userId, spine, body, d)
  if (resolved.clarification !== null) {
    return { ...rejectedPreview(body.base_version, []), clarification: resolved.clarification }
  }
  if (resolved.ops.length === 0) {
    return { ...rejectedPreview(body.base_version, [{ rule: "op_value_missing", message: "Không có thay đổi nào để xem trước" }]) }
  }

  const notWritable = notWritableViolations(resolved.ops)
  if (notWritable.length > 0) return rejectedPreview(body.base_version, notWritable)

  const txnId = randomUUID()
  let plan
  try {
    plan = planTransaction(spine, toTransaction(userId, body, resolved.ops, txnId), { startSeq: 1 })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    const rejected = rejectedPreview(body.base_version, err.violations, err.referrers)
    return { ...rejected, txn: txnId }
  }

  const impact = impactOfChanges(spine, plan.changes, plan.spine)
  const branch = branchOf(spine, impact)
  const previewId = randomUUID()
  prunePreviews(Date.now())
  previewStore.set(previewId, {
    projectId,
    base_version: body.base_version,
    ops: resolved.ops,
    reason: body.reason ?? null,
    impact,
    branch,
    expires_at: Date.now() + PREVIEW_TTL_MS
  })

  return {
    ok: true,
    txn: txnId,
    base_version: body.base_version,
    ops: plan.ops,
    changes: plan.changes.map(({ op, path, before, value, reason }) => ({ op, path, before, value, reason })),
    violations: [],
    referrers: impact.referrers,
    branch,
    impact,
    preview_id: previewId,
    ...(resolved.notes ? { notes: resolved.notes } : {})
  }
}

export interface ChangeApplyResult extends ApplyResult {
  branch: ChangeBranch
  impact: Impact
}

/**
 * Áp lô lên Spine trong một transaction rồi chạy lại deterministic check.
 * `preview_id` ⇒ dùng đúng lô đã xem trước, không gọi model lần hai.
 */
export const apply = async (
  projectId: string,
  userId: string,
  body: ChangeBody,
  init: repository.SpineInit = {},
  deps: Partial<ChangeDeps> = {}
): Promise<ChangeApplyResult> => {
  const d: ChangeDeps = { ...defaultChangeDeps(), ...deps }
  const record = await loadSpine(projectId, init)
  assertVersion(record, body.base_version)
  const spine = stripRecord(record)

  const stored = body.preview_id === undefined ? null : takePreview(projectId, body.preview_id)
  const resolved: ResolvedOps = stored
    ? { ops: stored.ops, clarification: null, notes: null }
    : await resolveOps(projectId, userId, spine, body, d)

  if (resolved.clarification !== null) {
    throw new NeedsClarificationError(resolved.clarification)
  }
  if (resolved.ops.length === 0) throw new ApiError(400, "Không có thay đổi nào để áp", "VALIDATION_ERROR")

  const notWritable = notWritableViolations(resolved.ops)
  if (notWritable.length > 0) throw new TransactionRejectedError(OP_INVALID, notWritable)

  const reason = body.reason ?? stored?.reason ?? undefined
  // Kiểm nhánh trước khi ghi: sau baseline thì lô nào cũng phải có lý do (vào §I Record of Changes)
  const plan = planTransaction(spine, toTransaction(userId, { ...body, ...(reason === undefined ? {} : { reason }) }, resolved.ops), {
    startSeq: 1
  })
  const impact = stored?.impact ?? impactOfChanges(spine, plan.changes, plan.spine)
  const branch = stored?.branch ?? branchOf(spine, impact)

  if (branch === "post_baseline" && (reason === undefined || reason.trim() === "")) {
    throw new ApiError(400, "Dự án đã có baseline — mọi thay đổi cần ghi lý do (vào Record of Changes)", "VALIDATION_ERROR")
  }

  // Project cũ chưa có Spine: tạo Spine rỗng như GET /spine để lô đầu tiên có chỗ ghi
  await repository.getOrCreate(projectId, init)
  const applied = await applyTransaction(projectId, toTransaction(userId, { ...body, ...(reason === undefined ? {} : { reason }) }, resolved.ops))

  // Cờ tính lại sau khi ghi: thay đổi của user có thể mở cờ đỏ mới (chặn baseline kế tiếp).
  if (applied.txn !== null) await d.recomputeFlags(projectId, userId)
  const after = await repository.get(projectId)

  return {
    ...applied,
    ...(after ? { spine: after, spine_version: after.spine_version } : {}),
    branch,
    impact
  }
}
