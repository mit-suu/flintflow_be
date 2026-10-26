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
import { stampAddendum } from "./addendum-stamp.js"
import { nameElementIds } from "./human-labels.js"
import { BRIEF_PROJECT_WRITE_MESSAGE, briefCoreEntries, isInBriefPhase, writesProjectVisionOrGoals } from "./brief-core.js"
import { PathError, parsePath } from "./path-resolver.js"
import { USE_CASE_NAME_FIX, useCaseNameIssues } from "./deterministic-check.js"
import { FIELD_SECTION_MAP, FIXED_SECTIONS } from "./section-registry.js"
import { elementFieldsOf } from "./element-defaults.js"
import { newUseCaseGapNote, newUseCaseGaps } from "./new-usecase-gaps.js"
import { assertCrInfo, crReason, nextCrId } from "./post-baseline-cr.js"
import {
  addedScreenIds,
  addsUseCaseOrScreen,
  applyScreenKind,
  screenKindChoice,
  screenKindQuestion,
  isAddUseCaseInstruction,
  messagesReady,
  newUseCaseScreenIssues,
  normalizeUseCaseBatch,
  useCaseContext,
  useCaseMode,
  useCaseOverlapNote,
  useCaseOverlaps,
  useCaseScreenNote,
  useCaseScreenProblemText,
  wantsSharedScreen,
  uiAskedBefore,
  confirmedProposals,
  applyUiPlan,
  uiPlanFor,
  uiPlanForModel,
  uiPlanIssues,
  uiPlanNote,
  uiPlanProblemText,
  removalLeftovers,
  removalNote,
  removalProblemText,
  removesUseCaseOrScreen,
  useCaseIntent,
  type RemovalLeftover,
  type UiPlanEntry,
  type UseCaseMode
} from "./use-case-propagation.js"
import { isSelfContainedBatch, reacceptOps } from "./reviewed-batch.js"
import { layoutRenderDeps, renderChangedIfAvailable } from "../diagram/diagram.service.js"
import type { Change, Spine, SpineRecord } from "./spine.types.js"
import { ActionType, AiActionError, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { ChangeInstructionOutput, LocalizedEntry } from "../../shared/ai/response-parser.js"
import { documentLanguageForTurn, documentLanguageInput, languagePairOf, type TurnDocumentLanguage, type TurnLanguagePair } from "../translation/turn-language.js"
import { captureForTurn } from "../translation/capture.service.js"
import { assertDraftUnlocked } from "./draft-lock.js"
import { expandIndexSelectors } from "./index-selector-fix.js"
import type { ChangeRequestInfo } from "../pipeline/pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { DEFAULT_REPLY_LANGUAGE, byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"

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

export const notWritableViolations = (ops: readonly Op[], spine?: Pick<Spine, "project" | "progress" | "steps">): Violation[] =>
  ops.flatMap((op, index): Violation[] => {
    // Pha Brief (kể cả project mới chưa chạy step, current_phase null): tầm nhìn/mục tiêu nằm ở addendum lõi, project.vision/goals chỉ do S-1.1 dựng
    if (spine && isInBriefPhase(spine) && writesProjectVisionOrGoals(op, spine)) {
      return [{ rule: "path_not_writable", path: op.path, op_index: index, message: BRIEF_PROJECT_WRITE_MESSAGE }]
    }
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
  /** Người xem trước — chỉ chính họ đính kèm được bản xem trước vào CR (mode 1 v3, 3.1). */
  userId: string
  /** Câu lệnh người dùng gõ; gửi lô op sẵn thì `null`. */
  instruction: string | null
  base_version: number
  ops: Op[]
  reason: string | null
  impact: Impact
  branch: ChangeBranch
  /**
   * FLF-265 D16: chữ theo ngôn ngữ tài liệu model trả kèm lô (hoặc lô hoà giải gom lại) + ngôn ngữ của lượt xem trước —
   * lưu cùng preview vì lượt áp (`preview_id`) không gọi model lần hai; áp xong mới lưu bản dịch.
   */
  localized?: LocalizedEntry[]
  language?: TurnLanguagePair | null
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

/**
 * Mode 1 v3 (BPMN 3.1): bản xem trước đính kèm vào CR làm **gợi ý** cho 3.2/3.4/3.6 — chỉ đọc, không xoá (mode 1 không
 * áp bản xem trước). Hết hạn / của người khác / project khác ⇒ `null` (CR vẫn tạo, không kèm gợi ý).
 */
export const peekPreview = (projectId: string, previewId: string, userId: string): { instruction: string | null; ops: Op[] } | null => {
  prunePreviews(Date.now())
  const stored = previewStore.get(previewId)
  if (!stored || stored.projectId !== projectId || stored.userId !== userId) return null
  return { instruction: stored.instruction, ops: stored.ops }
}

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

/** Trần phần tử mỗi collection khi lệnh chỉ ra cả một mục — đủ cho ERD / sơ đồ use case cỡ thật, vẫn không phải cả Spine. */
const SECTION_ELEMENT_LIMIT = 80

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Mục cố định lệnh nhắc tới: "§3.1.5 …" (nút "Sửa mục này" luôn điền sẵn) hoặc tên mục nhiều từ ("Entity Relationship
 * Diagram"). Mục dẫn xuất (Record of Changes, Glossary tự tính) không có dữ liệu để sửa nên bỏ.
 */
export const referencedSections = (haystack: string): string[] =>
  FIXED_SECTIONS.filter((s) => !s.derived)
    .filter((s) => {
      const number = s.id.slice("fixed:".length)
      if (new RegExp(`§\\s*${escapeRe(number)}(?![.\\d])`).test(haystack)) return true
      return s.title_en.includes(" ") && haystack.includes(s.title_en.toLowerCase())
    })
    .map((s) => s.id)

/**
 * Collection nuôi một mục (bảng §4): field mục sở hữu, và với mục là sơ đồ thì cả field sinh ra sơ đồ đó (cột Suy dẫn
 * `diagram:<kind>`). §3.1.5 ⇒ entities; §2.2.1 Use Case Diagram ⇒ actors + use_cases; §3.1.1 ⇒ screens.
 */
export const sectionCollections = (sectionId: string): string[] => {
  const kinds = FIELD_SECTION_MAP.filter((r) => r.owner.includes(sectionId) && r.key.startsWith("diagram_")).map((r) => r.key.slice("diagram_".length))
  const rows = FIELD_SECTION_MAP.filter((r) => r.owner.includes(sectionId) || kinds.some((k) => r.derived.includes(`diagram:${k}`)))
  const roots = rows.flatMap((r) => r.field.split(",").map((f) => /^\s*([a-z_]+)\[/.exec(f)?.[1] ?? ""))
  return [...new Set(roots)].filter((c) => (TARGET_COLLECTIONS as readonly string[]).includes(c) || c === "permissions")
}

/** Lệnh nói về phân quyền màn hình (§3.1.3) dù không nhắc tên màn hay vai trò nào. */
const AUTHORIZATION_HINT = /3\.1\.3|authori[sz]ation|permission|phân quyền|quyền truy cập/i

/**
 * Phân quyền màn hình là các dòng `permissions[]` `{id, screen_id, role_id, action}`, không phải field của `screens[]`.
 * Collection này không có tên nên không khớp theo chữ như `TARGET_COLLECTIONS`: thiếu nó, model đoán ra
 * `screens[].authorized_role_ids` và lô chết vì sai schema. Lấy dòng của màn được nhắc; không nhắc màn thì dòng của vai trò
 * được nhắc; lệnh chỉ nói "phân quyền / §3.1.3" thì tất cả (có trần).
 */
const permissionRows = (spine: Spine, haystack: string, projection: Record<string, unknown>): Spine["permissions"] => {
  const ids = (key: string) => new Set(((projection[key] as { id?: unknown }[] | undefined) ?? []).map((el) => String(el.id)))
  const screens = ids("screens")
  const roles = ids("roles")
  if (screens.size > 0) return spine.permissions.filter((p) => screens.has(p.screen_id)).slice(0, PERMISSION_ROW_LIMIT)
  if (roles.size > 0) return spine.permissions.filter((p) => roles.has(p.role_id)).slice(0, PERMISSION_ROW_LIMIT)
  return AUTHORIZATION_HINT.test(haystack) ? spine.permissions.slice(0, PERMISSION_ROW_LIMIT) : []
}

/** Dòng phân quyền gọn (4 field) nên trần cao hơn `PROJECTION_ELEMENT_LIMIT`. */
const PERMISSION_ROW_LIMIT = 120

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

  // Lệnh chỉ ra cả một mục ("Trong §3.1.5 Entity Relationship Diagram: …") mà không nhắc tên phần tử nào: không có
  // dòng này model chỉ thấy id + tên entity, không thấy quan hệ, và đòi user dán lại ERD.
  // FLF-248: mục được nhắc mà collection còn rỗng (vd §5.2 khi S-7.2 không ghi gì) — trước đây bị bỏ qua nên model
  // không biết `common_requirements` tồn tại, đoán ghi vào `nfrs[]` rồi lô chết vì sai schema. Nay đưa đường add + field.
  const emptyCollections: Record<string, { add_path: string; fields: string[] }> = {}
  for (const collection of referencedSections(haystack).flatMap(sectionCollections)) {
    // Nhắc cả mục lẫn một phần tử ("§3.1.5 … nối User với Grade") ⇒ vẫn cần đủ mục, không chỉ phần tử được nhắc
    if (collection === "permissions") continue
    const list = spine[collection as (typeof TARGET_COLLECTIONS)[number]] as unknown as Record<string, unknown>[]
    if (!Array.isArray(list)) continue
    if (list.length === 0) {
      projection[collection] = []
      emptyCollections[collection] = { add_path: `${collection}[]`, fields: elementFieldsOf(collection) }
      matched += 1
      continue
    }
    projection[collection] = list.slice(0, SECTION_ELEMENT_LIMIT)
    matched += Math.min(list.length, SECTION_ELEMENT_LIMIT)
  }
  if (Object.keys(emptyCollections).length > 0) projection.empty_collections = emptyCollections

  const permissions = permissionRows(spine, haystack, projection)
  if (permissions.length > 0) {
    projection.permissions = permissions
    existingIds.permissions = spine.permissions.map((p) => p.id).slice(0, 200)
    // Dòng phân quyền chỉ mang id ⇒ kèm tên vai trò/màn (gọn) để model đọc được "S01/R04" là Login/Guest
    if (!projection.roles) projection.roles = spine.roles.map(({ id, name, actor_id }) => ({ id, name, actor_id }))
    if (!projection.screens) projection.screens = spine.screens.slice(0, PERMISSION_ROW_LIMIT).map(({ id, name }) => ({ id, name }))
    matched += permissions.length
  }

  // Pha Brief: tầm nhìn/mục tiêu là entry addendum lõi (ngôn ngữ user + bản EN) — model sửa ở đó, không ở project
  if (isInBriefPhase(spine)) {
    const core = briefCoreEntries(spine)
    const entries = [...(core.vision ? [core.vision] : []), ...core.goals]
    if (entries.length > 0) projection.brief_core = entries.map(({ id, topic, content, content_en }) => ({ id, topic, content, content_en }))
  }

  if (matched > 0) return { ...projection, existing_ids: existingIds }

  const index: Record<string, unknown> = {}
  for (const collection of TARGET_COLLECTIONS) {
    const list = spine[collection] as unknown as Record<string, unknown>[]
    if (!Array.isArray(list) || list.length === 0) continue
    index[collection] = list.slice(0, PROJECTION_ELEMENT_LIMIT).map((element) => ({ id: element.id, label: textOf(element) }))
  }
  return { ...index, ...(projection.brief_core ? { brief_core: projection.brief_core } : {}), existing_ids: existingIds }
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

/**
 * FLF-260: động từ tiếng Anh thêm cho phiên tiếng Anh — chỉ nhận ở ĐẦU câu (sau "please" cũng được). Xét trong cửa sổ
 * 4 từ thì câu hỏi tiếng Việt nhắc tên phần tử tiếng Anh ("Màn Create Order có những trường nào") thành lệnh sửa.
 */
const LEADING_CHANGE_VERBS: readonly string[] = Object.freeze(["create", "edit", "insert", "modify"])

/** Dấu hiệu câu hỏi — không coi là lệnh sửa dù có động từ. */
const QUESTION_MARKERS: readonly string[] = Object.freeze(["?", "là gì", "tại sao", "thế nào", "có nên", "vì sao"])

/** Từ hỏi tiếng Anh, khớp nguyên từ (FLF-260): khớp chuỗi con thì "how" trong "showing" biến lệnh sửa thành câu hỏi. */
const QUESTION_WORDS = /\b(?:what|why|how)\b/

/** Số từ đầu câu được xét — "đổi tên actor A01" nhận, "tôi nghĩ là nên đổi" thì không. */
export const CHANGE_VERB_WINDOW = 4

/**
 * Tin nhắn ở session KHÔNG pipeline có phải lệnh sửa SRS không (Phases §2.3: mọi sửa đổi đi qua
 * change flow, kể cả gõ từ một session hỏi đáp). Không nhận ⇒ vẫn là CHAT thường.
 */
export const isChangeInstruction = (message: string): boolean => {
  const text = message.trim().toLowerCase()
  if (text.length === 0) return false
  if (QUESTION_MARKERS.some((marker) => text.includes(marker)) || QUESTION_WORDS.test(text)) return false
  const words = text.split(/\s+/).map((word) => word.replace(/[^\p{L}]/gu, ""))
  const lead = words[0] === "please" ? words[1] : words[0]
  if (lead !== undefined && LEADING_CHANGE_VERBS.includes(lead)) return true
  return words.slice(0, CHANGE_VERB_WINDOW).some((word) => CHANGE_VERBS.includes(word))
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
  /**
   * FLF-265 D16: ngôn ngữ tài liệu của lượt — đọc một lần trước lượt gọi model; `null` ⇒ không kèm khối "Document
   * language" (dự án `en`, mode 1). Thiếu ⇒ `documentLanguageForTurn` (unit test không nối Mongo ⇒ luôn `null`); test cắm
   * hàm giả để bật.
   */
  documentLanguage?: (projectId: string) => Promise<TurnDocumentLanguage | null>
  /**
   * FLF-311: lô vừa thêm use case / màn ⇒ vẽ lại sơ đồ đã cũ + bố cục màn mới. Không được ném (lỗi vẽ là dữ liệu, cờ
   * `diagram_stale` / `render_error` ghi nhận); thiếu ⇒ `renderChangedIfAvailable`.
   */
  renderAfterChange?: (projectId: string, userId: string, newScreenIds: string[]) => Promise<unknown>
}

export const defaultChangeDeps = (): ChangeDeps => ({
  changeExecutor: (actionType, input, projectId, userId) => executeAiAction<ChangeInstructionOutput>(actionType, input, projectId, userId),
  recomputeFlags: (projectId, userId) => flagsService.recompute(projectId, { by: userId }),
  documentLanguage: documentLanguageForTurn,
  renderAfterChange: (projectId, userId, newScreenIds) =>
    renderChangedIfAvailable(projectId, newScreenIds, { by: userId, step_id: null, deps: layoutRenderDeps() })
})

// ─── body ────────────────────────────────────────────────────────

export interface ChangeBody {
  base_version: number
  ops?: Op[]
  instruction?: string
  reason?: string
  preview_id?: string
  /** Phiên chat nơi user gõ lệnh — controller nạp đuôi transcript thành `chat_history` và ghi lượt này vào đó. */
  session_id?: string
  /**
   * Nội bộ (DTO không nhận): đuôi hội thoại trước lệnh này, để model hiểu câu trả lời cho câu hỏi làm rõ hay
   * "cái đó", "mục vừa nói" (UC 6.11). Không có ⇒ lệnh được hiểu độc lập như trước.
   */
  chat_history?: string
  /**
   * Nội bộ (DTO không nhận) — FLF-260: ngôn ngữ trả lời nơi gọi đã chốt (câu lệnh user gõ → ngôn ngữ phiên → tài khoản).
   * Có ⇒ lời gọi model trả câu hỏi làm rõ / ghi chú bằng ngôn ngữ đó, câu hỏi lại cố định cũng theo; không có ⇒ như cũ.
   */
  reply_language?: ReplyLanguage
  /** FLF-294: người yêu cầu + nguồn của change request (DTO `change_request`), bắt buộc sau baseline. */
  change_request?: ChangeRequestInfo
  /** Nội bộ (DTO không nhận) — FLF-294: lượt áp của hoà giải, việc kéo theo một CR đã ghi, không đòi CR riêng. */
  cr_exempt?: boolean
  /**
   * Nội bộ (DTO không nhận) — FLF-299: số câu hỏi làm rõ AI đã hỏi liên tiếp cho yêu cầu này (`clarificationRounds` của
   * phiên). Có ⇒ model không hỏi lại điều đã được trả lời; đủ `MAX_CLARIFICATION_ROUNDS` ⇒ ép soạn bản xem trước.
   */
  clarification_rounds?: number
  /**
   * Nội bộ (DTO `strictObject` không nhận — client không gửi được bản dịch, D7): lô `ops` do server gom (hoà giải) kèm chữ
   * theo ngôn ngữ tài liệu model trả cùng lô, và ngôn ngữ của lượt đó. Đi theo preview tới lượt áp.
   */
  localized?: LocalizedEntry[]
  document_language?: TurnLanguagePair | null
}

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const loadSpine = async (projectId: string, init: repository.SpineInit): Promise<SpineRecord> =>
  (await repository.get(projectId)) ?? { projectId, ...repository.createEmptySpine(init) }

const assertVersion = (record: SpineRecord, baseVersion: number): void => {
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
}

export interface ResolvedOps {
  ops: Op[]
  clarification: string | null
  /** FLF-311: lựa chọn kèm câu hỏi làm rõ (thẻ chọn nhanh trong chat). */
  choices?: string[]
  /** Người dùng rút lại yêu cầu đang dở — không có gì để xem trước hay áp. */
  withdrawn?: boolean
  /** Ghi chú ngắn model trả về, hiện trên thẻ preview. */
  notes: string | null
  /** FLF-265 D16: chữ theo ngôn ngữ tài liệu kèm lô (cùng `path` với op) + ngôn ngữ của lượt — lưu sau khi áp. */
  localized?: LocalizedEntry[]
  language?: TurnLanguagePair | null
  /** FLF-318: use case model đề xuất thêm ngoài yêu cầu (luật 3e) — lô cho change request ghi vào giả định để Lead xem. */
  proposed?: string[]
}

/** Model gửi field không có trong Spine (`screens[].authorized_role_ids`) — nhắc nó chỉ dùng field thấy trong projection. */
const SCHEMA_FIX =
  "Lô bị từ chối: chỉ ghi vào field có trong projection. Phân quyền màn hình là các dòng permissions[] {screen_id, role_id, action} " +
  "— thêm dòng để cấp quyền, remove permissions[id=…] để thu quyền; không có field nào kiểu authorized_role_ids trên screens[]"

/**
 * Lỗi của lô model vừa trả, để gọi lại model một lần kèm lỗi:
 * - lô không áp thử được (sai schema, phá bất biến) ⇒ các violation;
 * - FLF-243: tên use case model TỰ đặt mà cờ vàng `usecase_name_*` sẽ bắt. Tên user gõ nguyên văn thì để yên.
 */
/** Lệnh thêm use case có màn: phần giao diện còn thiếu của các use case mới (lô không áp thử được ⇒ để lỗi bất biến lo). */
const screenIssuesOf = (spine: Spine, ops: Op[], ucMode: UseCaseMode | null, allowShared: boolean, uiPlan: readonly UiPlanEntry[] = []) => {
  if (ops.length === 0 || (ucMode !== "screen_pending" && ucMode !== "full")) return { screen: [], plan: [] }
  try {
    const planned = planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 })
    const expectUseCase = !(uiPlan.length > 0 && uiPlan.every((e) => e.drop))
    return { screen: newUseCaseScreenIssues(spine, planned.spine, { allowShared, expectUseCase }), plan: uiPlanIssues(spine, planned.spine, uiPlan) }
  } catch (err) {
    if (err instanceof TransactionRejectedError) return { screen: [], plan: [] }
    throw err
  }
}

/** FLF-318: phần lô xoá use case còn bỏ lại (lô không áp thử được ⇒ để lỗi bất biến lo). */
const removalLeftoversOf = (spine: Spine, ops: Op[]): RemovalLeftover[] => {
  if (ops.length === 0) return []
  try {
    return removalLeftovers(spine, planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 }).spine)
  } catch (err) {
    if (err instanceof TransactionRejectedError) return []
    throw err
  }
}

const batchProblems = (
  spine: Spine,
  ops: Op[],
  instruction: string,
  ucMode: UseCaseMode | null = null,
  allowShared = false,
  uiPlan: readonly UiPlanEntry[] = [],
  /** FLF-318: lệnh xoá use case ⇒ phần chỉ thuộc use case bị xoá phải đi cùng lô (luật 3g). */
  removesUseCase = false
): string[] => {
  if (ops.length === 0) return []
  let plan: ReturnType<typeof planTransaction>
  try {
    plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) return []
    const messages = err.violations.map((v) => v.message)
    return err.violations.some((v) => v.rule === "schema_invalid") ? [...messages, SCHEMA_FIX] : messages
  }
  const asked = instruction.toLowerCase()
  const naming = useCaseNameIssues(spine, plan.spine)
    .filter((issue) => !asked.includes(issue.name.toLowerCase()))
    .map((issue) => issue.message)
  // Lệnh thêm use case có màn: mỗi use case mới phải có màn (theo lựa chọn của user), luồng vào và quyền
  const ui = screenIssuesOf(spine, ops, ucMode, allowShared, uiPlan)
  const screens = [...ui.screen.map(useCaseScreenProblemText), ...ui.plan.map(uiPlanProblemText)]
  const leftovers = removesUseCase ? removalLeftovers(spine, plan.spine).map(removalProblemText) : []
  return [...(naming.length > 0 ? [...naming, USE_CASE_NAME_FIX] : []), ...screens, ...leftovers]
}

/** Model trả output sai khuôn (không op, không câu hỏi) ⇒ hỏi lại user thay vì đẩy lỗi Zod tiếng Anh ra giao diện. */
const UNCLEAR_INSTRUCTION: Readonly<Record<ReplyLanguage, string>> = {
  vi:
    "Mình chưa xác định được cần đổi gì trong tài liệu. Bạn nói rõ mục và nội dung muốn đổi giúp mình " +
    "(ví dụ: \"thêm quyền view màn Login cho Teacher\"). Sơ đồ được vẽ lại tự động từ dữ liệu — muốn vẽ lại ngay thì bấm \"Vẽ lại sơ đồ\" dưới hình.",
  en:
    "I couldn't tell what to change in the document. Please tell me which section and what content you want to change " +
    "(for example: \"add view permission on the Login screen for Teacher\"). Diagrams are redrawn automatically from the data — " +
    "to redraw one right away, press \"Vẽ lại sơ đồ\" (Redraw diagram) below it."
}

const AI_OUTPUT_ERRORS = new Set(["SCHEMA_MISMATCH", "PARSE_FAILED"])

/**
 * Câu lệnh tự nhiên → lô op, hoặc một câu hỏi làm rõ (UC 6.11). Một lượt gọi model; lô có lỗi (áp thử bị từ chối, tên
 * use case sai luật — FLF-243) thì gọi lại đúng MỘT lần kèm lỗi — lần hai vẫn sai thì giữ lô để preview báo lỗi / cờ vàng bắt.
 */
/** Câu rút lại yêu cầu đang dở ("thôi không cần thêm nữa", "bỏ qua", "never mind") — chỉ xét khi đang trả lời câu hỏi. */
// Hết từ = không còn chữ cái theo sau (`\b` của JS coi "ỷ" là ký tự ngoài từ ⇒ "huỷ" không khớp)
const WITHDRAWAL = /^\s*(thôi|thoi|bỏ qua|bo qua|không cần|khong can|huỷ|hủy|huy|dừng|dung lai|cancel|never ?mind|skip it|forget it|no need)(?!\p{L})/iu
export const isWithdrawal = (text: string): boolean => WITHDRAWAL.test(text)
const WITHDRAWN = {
  vi: "Đã bỏ yêu cầu này — tài liệu không đổi gì. Khi cần, bạn cứ nhắn yêu cầu mới.",
  en: "Dropped this request — nothing in the document changed. Send a new request whenever you need."
}

/** FLF-299: sau số câu hỏi làm rõ này cho cùng một yêu cầu, model phải soạn bản xem trước thay vì hỏi tiếp. */
export const MAX_CLARIFICATION_ROUNDS = 2

const opsFromInstruction = async (
  projectId: string,
  userId: string,
  spine: Spine,
  instruction: string,
  chatHistory: string | undefined,
  replyLanguage: ReplyLanguage | undefined,
  deps: ChangeDeps,
  clarificationRounds = 0,
  /** FLF-318: `false` = soạn cho change request — không có người để hỏi, không hỏi giao diện / use case đề xuất thêm. */
  interactive = true
): Promise<ResolvedOps> => {
  const history = chatHistory?.trim() ?? ""
  // Người dùng rút lại yêu cầu đang dở (đang trả lời câu hỏi làm rõ) ⇒ dừng, không gọi model (model không có cách trả
  // "không làm gì" — lô rỗng bị schema từ chối 3 lần rồi thành câu "chưa xác định được cần đổi gì")
  if (interactive && clarificationRounds > 0 && isWithdrawal(instruction)) {
    return { ops: [], clarification: null, notes: byLanguage(replyLanguage ?? DEFAULT_REPLY_LANGUAGE, WITHDRAWN), withdrawn: true }
  }
  // FLF-311: lệnh thêm use case (hoặc câu trả lời cho câu hỏi làm rõ của lệnh đó) ⇒ model soạn đủ phần liên quan
  // FLF-318: lệnh xoá use case (động từ xoá đứng trước — "xoá UC vừa tạo" không phải lệnh thêm), hoặc câu trả lời cho câu
  // hỏi làm rõ của lệnh đó ⇒ lô xoá luôn phần chỉ thuộc use case bị xoá, use case cùng luồng thì hỏi trước (luật 3g)
  const removesUseCase = (useCaseIntent(instruction) ?? (clarificationRounds > 0 ? useCaseIntent(history) : null)) === "remove"
  const addsUseCase = !removesUseCase && (isAddUseCaseInstruction(instruction) || (clarificationRounds > 0 && isAddUseCaseInstruction(history)))
  const ucMode = addsUseCase ? useCaseMode(spine) : null
  const ucUi = ucMode === "screen_pending" || ucMode === "full"
  // FLF-311: câu trả lời cho câu hỏi giao diện ⇒ kế hoạch từng use case (màn riêng / popup / màn có sẵn / dùng chung)
  const uiPlan = ucUi ? uiPlanFor(instruction, history) : []
  // Có kế hoạch ⇒ dùng chung hay không do kế hoạch kiểm; không có ⇒ user nói "dùng chung" thì không nhắc tách màn
  const allowShared = ucMode !== null && (uiPlan.length > 0 || wantsSharedScreen(instruction, history))
  // Op chỉ số trên mảng chuỗi (`normal[2]`) ⇒ set cả mảng (op engine cấm chỉ số)
  const prepare = (ops: Op[]): Op[] =>
    applyUiPlan(expandIndexSelectors(spine, ucMode ? normalizeUseCaseBatch(spine, stampAddendum(ops)) : stampAddendum(ops)), uiPlan)
  // FLF-265 D16: một lần cho cả lượt (kể cả lượt gọi lại kèm lỗi)
  const language = await (deps.documentLanguage ?? documentLanguageForTurn)(projectId)
  const call = (previousProblems?: string) =>
    deps.changeExecutor(
      ActionType.CHANGE_INSTRUCTION,
      {
        promptVariables: {
          call_kind: "change_instruction",
          user_message: instruction,
          chat_history: history || "(none)",
          is_pipeline: false,
          has_baseline: spine.baselines.length > 0,
          // Câu trả lời cho câu hỏi làm rõ ("A03") thường không nhắc lại thực thể của yêu cầu gốc ⇒ dò cả đoạn hội thoại
          projection: {
            ...buildChangeProjection(spine, history ? `${history}\n${instruction}` : instruction),
            ...(ucMode ? { use_case_context: { ...useCaseContext(spine, ucMode), ...(uiPlan.length ? { ui_plan: uiPlanForModel(uiPlan) } : {}) } } : {}),
            // Lệnh xoá: model cần thấy chức năng / màn / thông báo của mọi use case để biết phần nào chỉ thuộc use case bị xoá
            ...(removesUseCase ? { use_case_context: useCaseContext(spine, "full") } : {})
          },
          use_case_mode: ucMode ?? "none",
          use_case_removal: removesUseCase,
          use_case_ui: ucMode === "screen_pending" || ucMode === "full",
          messages_ready: ucMode === "full" && messagesReady(spine),
          glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
          stale_sections: [],
          clarification_rounds: clarificationRounds,
          ...(previousProblems ? { previous_problems: previousProblems } : {})
        },
        // FLF-260: `buildPrompt` nối khối "Reply language" cuối prompt — câu hỏi làm rõ, ghi chú theo ngôn ngữ của lượt
        ...(replyLanguage ? { replyLanguage } : {}),
        // FLF-265 D16: ngôn ngữ tài liệu ≠ ngôn ngữ gốc ⇒ `buildPrompt` nối khối "Document language", model trả `localized`
        ...documentLanguageInput(language)
      },
      projectId,
      userId
    )

  let result: Awaited<ReturnType<typeof call>>
  try {
    result = await call()
  } catch (err) {
    if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) {
      return { ops: [], clarification: byLanguage(replyLanguage ?? DEFAULT_REPLY_LANGUAGE, UNCLEAR_INSTRUCTION), notes: null }
    }
    throw err
  }
  // FLF-299: đã hỏi đủ mà model vẫn hỏi ⇒ gọi lại MỘT lần, bắt soạn từ câu trả lời của user + projection
  if (result.data.clarification_needed?.trim() && clarificationRounds >= MAX_CLARIFICATION_ROUNDS) {
    const forced = await call(
      `You already asked ${clarificationRounds} clarifying questions for this request and the user answered them. Do not ask again: draft the batch now from those answers and the projection (rule 2a).`
    ).catch((err: unknown) => {
      if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) return null
      throw err
    })
    if (forced && !forced.data.clarification_needed?.trim() && (forced.data.ops ?? []).length > 0) result = forced
  }
  // Lô sai thì gọi lại kèm lỗi: một lần; có kế hoạch giao diện (lệnh nhiều use case, 3–4 màn) thì tới hai lần
  for (let attempt = 0, max = uiPlan.length > 0 ? 2 : 1; attempt < max && !result.data.clarification_needed?.trim(); attempt++) {
    const problems = batchProblems(spine, prepare((result.data.ops ?? []) as Op[]), instruction, ucMode, allowShared, uiPlan, removesUseCase)
    if (problems.length === 0) break
    const retry = await call(problems.join("\n")).catch((err: unknown) => {
      if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) return null
      throw err
    })
    if (!retry || retry.data.clarification_needed?.trim() || (retry.data.ops ?? []).length === 0) break
    result = retry
  }

  // Câu hỏi làm rõ và ghi chú preview hiện thẳng cho user: mã phần tử model còn chép (`S02`) đổi sang tên
  const clarification = result.data.clarification_needed?.trim()
  const choices = result.data.choices?.length ? { choices: result.data.choices.map((c) => nameElementIds(c, spine)) } : {}
  if (clarification) return { ops: [], clarification: nameElementIds(clarification, spine), notes: null, ...choices }
  let ops = prepare((result.data.ops ?? []) as Op[])
  // FLF-311: giao diện là quyết định của người dùng. Đã chọn ⇒ code áp đúng lựa chọn; chưa chọn mà lô thêm màn và đoạn
  // hội thoại chưa có câu hỏi giao diện ⇒ hỏi (kèm lựa chọn nhanh) thay vì tự quyết — model không tự hỏi phần này.
  // Use case model ĐỀ XUẤT thêm mà người dùng chưa xác nhận giữ / bỏ ⇒ luôn hỏi (kể cả khi đã chọn màn riêng / popup).
  if (ucUi) {
    const userText = [instruction, ...history.split("\n").filter((l) => l.startsWith("User:"))].join("\n")
    const proposed = uiPlan.length > 0 ? [] : confirmedProposals(spine, ops, result.data.proposed_use_cases ?? [], userText)
    const kind = uiPlan.length > 0 ? null : screenKindChoice(instruction, history)
    // FLF-318: soạn cho change request (`interactive = false`) không có người để hỏi — vẫn áp lựa chọn đã ghi trong lệnh
    if (interactive && (proposed.length > 0 || (!kind && !uiAskedBefore(history) && clarificationRounds <= MAX_CLARIFICATION_ROUNDS))) {
      const ask = screenKindQuestion(spine, ops, replyLanguage ?? DEFAULT_REPLY_LANGUAGE, proposed)
      if (ask) return { ops: [], clarification: ask.text, notes: null, choices: ask.choices }
    }
    if (kind) ops = applyScreenKind(ops, kind)
  }
  // Còn thiếu sau lượt soạn lại ⇒ báo trên bản xem trước, người dùng quyết định (không chặn)
  const left = screenIssuesOf(spine, ops, ucMode, allowShared, uiPlan)
  const noteLanguage = replyLanguage ?? DEFAULT_REPLY_LANGUAGE
  const leftovers = removesUseCase ? removalNote(removalLeftoversOf(spine, ops), noteLanguage) : null
  const notes =
    [result.data.notes ? nameElementIds(result.data.notes, spine) : null, useCaseScreenNote(left.screen, noteLanguage), uiPlanNote(left.plan, noteLanguage), leftovers]
      .filter(Boolean)
      .join("\n") || null
  const localized = result.data.localized?.length ? { localized: result.data.localized } : {}
  const proposed = result.data.proposed_use_cases?.length ? { proposed: [...result.data.proposed_use_cases] } : {}
  return { ops, clarification: null, notes, ...localized, ...proposed, language: languagePairOf(language) }
}

/**
 * FLF-318: lô thêm / xoá use case cho change request (sau baseline ⇒ `full`) — cùng prompt, cùng luật soạn, chuẩn hoá và
 * soát của chat trước baseline (luật 3e: thêm kéo theo + người xử lý; luật 3g: xoá kéo theo phần chỉ thuộc nó), nhưng
 * không hỏi lại: câu hỏi đã hỏi ở bước làm rõ của CR (C-2) và câu trả lời nằm trong `instruction`; model vẫn hỏi ⇒ gọi
 * lại bắt soạn (FLF-299); vẫn hỏi ⇒ `clarification` để caller rơi về đề xuất theo từng vị trí. Lệnh nói rõ màn riêng /
 * popup thì áp đúng lựa chọn đó. Không ghi gì.
 */
export const draftUseCaseOps = (
  projectId: string,
  userId: string,
  spine: Spine,
  instruction: string,
  deps: Partial<ChangeDeps> = {}
): Promise<ResolvedOps> =>
  opsFromInstruction(projectId, userId, spine, instruction, undefined, undefined, { ...defaultChangeDeps(), ...deps }, MAX_CLARIFICATION_ROUNDS, false)

const resolveOps = async (
  projectId: string,
  userId: string,
  spine: Spine,
  body: ChangeBody,
  deps: ChangeDeps
): Promise<ResolvedOps> => {
  if (body.ops !== undefined) {
    return { ops: body.ops, clarification: null, notes: null, ...(body.localized?.length ? { localized: body.localized, language: languagePairOf(body.document_language) } : {}) }
  }
  if (body.instruction === undefined) throw new ApiError(400, "Vui lòng nhập nội dung cần sửa.", "VALIDATION_ERROR")
  return await opsFromInstruction(projectId, userId, spine, body.instruction, body.chat_history, body.reply_language, deps, body.clarification_rounds)
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
  /**
   * Nội bộ (không trả qua HTTP — controller bỏ đi) — FLF-311: lựa chọn kèm `clarification`, ghi vào phiên chat dạng
   * `questions[].options` để FE hiện thẻ chọn nhanh.
   */
  clarification_choices?: string[]
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
  assertDraftUnlocked(record)
  const spine = stripRecord(record)

  const resolved = await resolveOps(projectId, userId, spine, body, d)
  if (resolved.clarification !== null) {
    return {
      ...rejectedPreview(body.base_version, []),
      clarification: resolved.clarification,
      ...(resolved.choices?.length ? { clarification_choices: resolved.choices } : {})
    }
  }
  if (resolved.withdrawn) return { ok: true, txn: randomUUID(), base_version: body.base_version, ops: [], changes: [], violations: [], referrers: [], notes: resolved.notes ?? undefined }
  if (resolved.ops.length === 0) {
    return { ...rejectedPreview(body.base_version, [{ rule: "op_value_missing", message: "Không có thay đổi nào để xem trước" }]) }
  }

  const notWritable = notWritableViolations(resolved.ops, spine)
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
  // FLF-298: use case mới chưa có chức năng/màn hình — sửa không tự lan, báo ngay để author yêu cầu tiếp
  // FLF-311: use case mới chồng mục tiêu với use case có sẵn cùng actor ⇒ cảnh báo (lưới an toàn sau luật 3e)
  const notes = [
    resolved.notes,
    newUseCaseGapNote(newUseCaseGaps(spine, plan.spine), body.reply_language),
    useCaseOverlapNote(useCaseOverlaps(spine, plan.spine), body.reply_language)
  ]
    .filter(Boolean)
    .join("\n")
  const previewId = randomUUID()
  prunePreviews(Date.now())
  previewStore.set(previewId, {
    projectId,
    userId,
    instruction: body.instruction?.trim() || null,
    base_version: body.base_version,
    ops: resolved.ops,
    reason: body.reason ?? null,
    impact,
    branch,
    ...(resolved.localized?.length ? { localized: resolved.localized, language: languagePairOf(resolved.language) } : {}),
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
    ...(notes ? { notes } : {})
  }
}

export interface ChangeApplyResult extends ApplyResult {
  branch: ChangeBranch
  impact: Impact
  /** FLF-294: mã change request của lượt áp sau baseline; trước baseline / hoà giải ⇒ `null`. */
  cr_id?: string | null
}

/**
 * FLF-318: ghi lại `accepted_at` cho step sở hữu các section mà lô thêm use case vừa duyệt (cùng lượt vẽ lại sơ đồ) làm
 * stale — một transaction riêng, lý do nội bộ (`gate:` ⇒ không vào §I). Lỗi chỉ ghi log: lô đã ghi, section còn stale thì
 * người dùng hoà giải như trước.
 */
const reacceptReviewedSections = async (projectId: string, userId: string, before: Spine, batch: readonly Change[]): Promise<void> => {
  try {
    const firstSeq = Math.min(...batch.map((c) => c.seq))
    const [current, changes] = await Promise.all([repository.get(projectId), repository.listChanges(projectId)])
    if (!current) return
    const ops = reacceptOps(before, changes.filter((c) => c.seq < firstSeq), stripRecord(current), changes, new Date().toISOString())
    if (ops.length === 0) return
    await applyTransaction(projectId, {
      base_version: current.spine_version,
      ops,
      by: userId,
      step_id: null,
      reason: "gate: đã duyệt qua bản xem trước lô thêm use case"
    })
  } catch (err) {
    console.warn(`[change] ${projectId}: đánh dấu đã duyệt các section của lô thêm use case lỗi — section còn stale`, err)
  }
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
  assertDraftUnlocked(record)
  const spine = stripRecord(record)
  // FLF-294 (BR-03): sau baseline lượt áp là một change request — kiểm TRƯỚC khi lấy bản xem trước (`takePreview` xoá
  // nó), để author thiếu người yêu cầu / nguồn điền rồi bấm lại vẫn còn bản xem trước. Hoà giải là việc kéo theo của CR.
  const crInfo = spine.baselines.length > 0 && !body.cr_exempt ? assertCrInfo(body.change_request) : null

  const stored = body.preview_id === undefined ? null : takePreview(projectId, body.preview_id)
  const resolved: ResolvedOps = stored
    ? { ops: stored.ops, clarification: null, notes: null, ...(stored.localized ? { localized: stored.localized, language: languagePairOf(stored.language) } : {}) }
    : await resolveOps(projectId, userId, spine, body, d)

  if (resolved.clarification !== null) {
    throw new NeedsClarificationError(resolved.clarification)
  }
  if (resolved.ops.length === 0) throw new ApiError(400, "Không có thay đổi nào để áp", "VALIDATION_ERROR")

  const notWritable = notWritableViolations(resolved.ops, spine)
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

  // FLF-294: mã cấp sau mọi bước kiểm của lượt áp (lỗi trước đó không phí số); mã + người yêu cầu + nguồn vào reason
  const crId = crInfo && reason ? await nextCrId(projectId) : null
  const recorded = crId && crInfo && reason ? crReason(crId, crInfo, reason) : reason

  // Project cũ chưa có Spine: tạo Spine rỗng như GET /spine để lô đầu tiên có chỗ ghi
  await repository.getOrCreate(projectId, init)
  const applied = await applyTransaction(projectId, toTransaction(userId, { ...body, ...(recorded === undefined ? {} : { reason: recorded }) }, resolved.ops))
  // FLF-265 D16: Spine đã ghi ⇒ lưu bản ngôn ngữ tài liệu kèm lô (lỗi chỉ log, không làm hỏng lượt ghi)
  await captureForTurn(projectId, resolved.language, resolved.ops, resolved.localized)

  // FLF-311: thêm use case / màn ⇒ vẽ lại sơ đồ use case, screen flow và bố cục màn mới TRƯỚC khi tính cờ (khỏi cờ
  // `diagram_stale` cho chính lô này). Lỗi vẽ không làm hỏng lượt sửa.
  // FLF-318: xoá use case / màn cũng phải vẽ lại sơ đồ use case, screen flow (không để cờ `diagram_stale`)
  if (applied.txn !== null && (addsUseCaseOrScreen(spine, applied.spine) || removesUseCaseOrScreen(spine, applied.spine))) {
    await d.renderAfterChange?.(projectId, userId, addedScreenIds(spine, applied.spine))
    // FLF-318: lô trọn gói (chỉ thêm / chỉ xoá phần của chính nó), người dùng đã duyệt ở bản xem trước ⇒ không bắt duyệt lại
    // các section nó (và lượt vẽ lại) làm stale
    if (stored && isSelfContainedBatch(spine, applied.spine, applied.changes)) await reacceptReviewedSections(projectId, userId, spine, applied.changes)
  }
  // Cờ tính lại sau khi ghi: thay đổi của user có thể mở cờ đỏ mới (chặn baseline kế tiếp).
  if (applied.txn !== null) await d.recomputeFlags(projectId, userId)
  const after = await repository.get(projectId)

  return {
    ...applied,
    ...(after ? { spine: after, spine_version: after.spine_version } : {}),
    branch,
    impact,
    cr_id: crId
  }
}
