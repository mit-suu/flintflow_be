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

import { assertNoMigrationRunning } from "../template-migration/migration-guard.js"
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
import { USE_CASE_NAME_FIX, useCaseNameIssues, type RuleProfile } from "./deterministic-check.js"
import {
  assumptionOps,
  assumptionsNote,
  predictRedFlags,
  predictedRedNote,
  sectionDraftProblems,
  stampChatSource,
  type ChatAssumption,
  type PredictedRedFlag
} from "./chat-edit-support.js"
import { chatEditVerdict } from "../pipeline/quiet-step.js"
import { activeDecisions } from "../pipeline/decisions.service.js"
import { recordAutoPass } from "../pipeline/auto-pass.service.js"
import mongoose from "mongoose"
import { FIELD_SECTION_MAP, FIXED_SECTIONS, sectionsOfPath } from "./section-registry.js"
import { classifyPlace, conflictFields, placeLabel, placeOfPath, placeValue, readableValue, rebaseOps, type PlaceOutcome } from "./concurrent-merge.js"
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
  uiPlanFromModel,
  askedList,
  uiPlanIssues,
  uiPlanNote,
  uiPlanProblemText,
  removalLeftovers,
  removalNote,
  removalProblemText,
  removesUseCaseOrScreen,
  useCaseIntent,
  useCaseEditContext,
  editIssues,
  editNote,
  editProblemText,
  type EditIssue,
  type UseCaseIntent,
  type RemovalLeftover,
  type UiPlanEntry,
  type UseCaseMode
} from "./use-case-propagation.js"
import { isSelfContainedBatch, ownedSections, reacceptOps } from "./reviewed-batch.js"
import { layoutRenderDeps, renderChangedIfAvailable } from "../diagram/diagram.service.js"
import type { Change, Spine, SpineRecord } from "./spine.types.js"
import { ActionType, AiActionError, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { ChangeInstructionOutput, LocalizedEntry } from "../../shared/ai/response-parser.js"
import { documentLanguageForTurn, documentLanguageInput, languagePairOf, type TurnDocumentLanguage, type TurnLanguagePair } from "../translation/turn-language.js"
import { captureForTurn } from "../translation/capture.service.js"
import { assertDraftUnlocked } from "./draft-lock.js"
import { expandIndexSelectors } from "./index-selector-fix.js"
import { stillOpenIn, targetFlagsOf, unresolvedAfter, unresolvedProblemText, type TargetFlag } from "./flag-target.js"
import type { ChangeRequestInfo } from "../pipeline/pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { splitInstruction } from "../../shared/utils/instruction-text.js"
import { DEFAULT_REPLY_LANGUAGE, byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import { isWithdrawal } from "../../shared/i18n/withdrawal.js"

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
  /** FLF-318: ý của cả vòng hỏi đáp (thêm / xoá / sửa use case) — lượt áp chỉ còn câu trả lời cuối, không đoán lại được. */
  use_case_intent?: UseCaseIntent | null
  /** Lời cảnh báo của AI ở lượt xem trước: người dùng bấm áp dụng bản này là "Vẫn làm" - giữ ý, ghi lại cho lượt kiểm sau đọc. */
  warning?: string
  /** Lệnh nhiều ý: bản xem trước chỉ là phần rõ, còn một câu hỏi cho phần mơ hồ chờ trả lời - áp bản này không khép yêu cầu. */
  request_open?: boolean
  /**
   * P12 (BF §3.2): giá trị lúc xem trước (`before`) và đề xuất (`after`) của từng chỗ lô chạm — lượt áp sau khi người khác
   * ghi kiểm lại theo nội dung từng chỗ thay vì 409 theo `spine_version` cả tài liệu.
   */
  places?: StoredPlace[]
  /** Lúc xem trước (ms) — giờ "① lúc AI soạn" của màn so sánh. */
  created_at?: number
  expires_at: number
}

interface StoredPlace {
  path: string
  before: unknown
  after: unknown
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
 * BF §3.2 "Hai người sửa cùng lúc" (trước baseline): bản xem trước sửa qua chat **chưa áp** của người khác treo ở người đó;
 * người khác mở chỗ đó thấy "<ai> có bản sửa chưa xác nhận ở mục này". Trả mục **sở hữu** (`owner`) bị đụng ⇒ userId đang
 * giữ, bỏ bản của chính `exceptUserId`. Kho preview sống trong tiến trình (như lượt áp `preview_id`).
 */
export const pendingPreviewSections = (projectId: string, exceptUserId: string): { section_id: string; user_ids: string[] }[] => {
  prunePreviews(Date.now())
  const bySection = new Map<string, Set<string>>()
  for (const stored of previewStore.values()) {
    if (stored.projectId !== projectId || stored.userId === exceptUserId) continue
    for (const section of stored.impact.sections) {
      if (section.relation !== "owner") continue
      const holders = bySection.get(section.id) ?? new Set<string>()
      holders.add(stored.userId)
      bySection.set(section.id, holders)
    }
  }
  return [...bySection].map(([section_id, users]) => ({ section_id, user_ids: [...users] }))
}

/** Người xem trước bấm Huỷ ⇒ bỏ bản xem trước ngay (không chờ hết hạn), để dòng "có bản sửa chưa xác nhận" tắt. */
export const discardPreview = (projectId: string, previewId: string, userId: string): boolean => {
  const stored = previewStore.get(previewId)
  if (!stored || stored.projectId !== projectId || stored.userId !== userId) return false
  previewStore.delete(previewId)
  return true
}

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
    throw new ApiError(422, "Bản xem trước đã hết hạn - hãy xem lại thay đổi rồi xác nhận", PREVIEW_EXPIRED)
  }
  previewStore.delete(previewId)
  return stored
}

/** Lượt áp đụng chỗ người khác vừa sửa ⇒ trả bản xem trước về kho: "Bỏ yêu cầu" xoá được, người khác vẫn thấy dòng chờ. */
const restorePreview = (previewId: string, stored: StoredPreview): void => {
  previewStore.set(previewId, { ...stored, expires_at: Math.max(stored.expires_at, Date.now() + PREVIEW_TTL_MS) })
}

const cloneValue = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Chỗ (phần tử Spine) lô op chạm, kèm giá trị lúc xem trước và đề xuất. */
const placesOf = (before: Spine, after: Spine, ops: readonly Op[]): StoredPlace[] => {
  const paths = [...new Set(ops.map((o) => placeOfPath(o.path)).filter((p): p is string => p !== null))]
  return paths.map((path) => ({ path, before: cloneValue(placeValue(before, path)), after: cloneValue(placeValue(after, path)) }))
}

// ─── P12: kiểm lại theo nội dung lúc xác nhận (BF §3.2, chốt câu 8) ──────

/** Một chỗ đụng phần người khác vừa sửa — ① lúc AI soạn · ② hiện tại (ai, lúc nào) · ③ đề xuất. */
export interface PlaceConflict {
  path: string
  section_id: string | null
  /** Tên phần tử (không mã nội bộ); "" ⇒ FE chỉ hiện tên mục. */
  label: string
  at_proposal: string
  current: string
  proposal: string
  changed_by: string
  changed_at: string | null
  proposed_at: string | null
}

/** Chỗ người khác đã sửa giống đề xuất ⇒ không ghi lại. */
export interface PlaceSame {
  path: string
  section_id: string | null
  label: string
  changed_by: string
}

export type LastEditor = (projectId: string, path: string) => Promise<{ name: string; at: Date | null } | null>

/** Người sửa gần nhất của một chỗ — đọc `changes` (CR ⇒ "Bình (CR-003)"). Nạp muộn để `spine/` không kéo module CR lúc load. */
const defaultLastEditor: LastEditor = async (projectId, path) => {
  const { actorName, lastEditOf } = await import("../change-request/concurrent-edit.js")
  const edit = await lastEditOf(projectId, path)
  return edit ? { name: await actorName(projectId, edit.by), at: edit.at } : null
}

const sectionOfPlace = (spine: Spine, path: string, field?: string): string | null => {
  try {
    const impact = sectionsOfPath(spine, field ? `${path}.${field}` : path)
    return impact.owner[0] ?? null
  } catch {
    return null
  }
}

const isPlainRow = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Chữ của đúng các field đụng nhau (không cả phần tử dạng JSON). */
const focusText = (value: unknown, fields: readonly string[]): string => {
  if (value === undefined) return ""
  if (!isPlainRow(value) || fields.length === 0) return readableValue(value)
  return fields.map((f) => readableValue(value[f])).filter(Boolean).join("\n\n")
}

interface Recheck {
  ops: Op[]
  same: PlaceSame[]
  conflicts: PlaceConflict[]
}

const recheckPlaces = async (projectId: string, current: Spine, stored: StoredPreview, lastEditor: LastEditor): Promise<Recheck> => {
  const outcomes = new Map<string, PlaceOutcome>()
  const same: PlaceSame[] = []
  const conflicts: PlaceConflict[] = []
  for (const place of stored.places ?? []) {
    const now = cloneValue(placeValue(current, place.path))
    const outcome = classifyPlace(place.before, place.after, now)
    outcomes.set(place.path, outcome)
    if (outcome.kind === "unchanged" || outcome.kind === "rebased") continue
    const editor = await lastEditor(projectId, place.path)
    const who = editor?.name ?? "người khác"
    const label = placeLabel(now ?? place.before)
    if (outcome.kind === "same") {
      same.push({ path: place.path, section_id: sectionOfPlace(current, place.path), label, changed_by: who })
      continue
    }
    const fields = conflictFields(outcome.at)
    conflicts.push({
      path: place.path,
      section_id: sectionOfPlace(current, place.path, fields[0]),
      label,
      at_proposal: focusText(place.before, fields),
      current: focusText(now, fields),
      proposal: focusText(place.after, fields),
      changed_by: who,
      changed_at: editor?.at ? editor.at.toISOString() : null,
      proposed_at: stored.created_at ? new Date(stored.created_at).toISOString() : null
    })
  }
  const conflicted = new Set(conflicts.map((c) => c.path))
  // Chỗ đụng nhau mà bên gọi cho bỏ qua (hoà giải) ⇒ bỏ op của chỗ đó, các chỗ khác vẫn ghi
  const ops = rebaseOps(stored.ops, current, outcomes).filter((op) => {
    const place = placeOfPath(op.path)
    return place === null || !conflicted.has(place)
  })
  return { ops, same, conflicts }
}

const conflictMessage = (conflicts: readonly PlaceConflict[], language: ReplyLanguage | undefined): string => {
  const who = [...new Set(conflicts.map((c) => c.changed_by))].join(", ")
  return byLanguage(language ?? DEFAULT_REPLY_LANGUAGE, {
    vi: `${who} vừa sửa đúng chỗ bạn định đổi - chưa ghi gì. Xem so sánh rồi chọn "AI soạn lại trên nội dung hiện tại" hoặc "Bỏ yêu cầu".`,
    en: `${who} just edited the exact text you meant to change - nothing was written. Compare, then pick "Redraft on the current content" or "Drop the request".`
  })
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
  "glossary",
  "references",
  "verifications"
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
/** Trần mỗi danh sách trong `draft_context` — đủ để soạn một mục riêng, không phải cả Spine. */
const DRAFT_CONTEXT_LIMIT = 30

/**
 * FLF-278 (mục riêng của mẫu khách): dữ kiện dự án dạng gọn (nhãn / câu, không id, không quan hệ) đi kèm mục riêng được
 * nhắc — để lệnh "Soạn nháp mục …" viết từ dữ liệu thật thay vì bịa, và biết thiếu gì để hỏi lại. Không đưa cả Spine.
 */
export const draftContextOf = (spine: Spine): Record<string, unknown> => {
  const { name, system_name, domain, type, vision, goals, form_factor, release_scope } = spine.project
  const take = <T, R>(list: readonly T[], pick: (item: T) => R) => list.slice(0, DRAFT_CONTEXT_LIMIT).map(pick)
  return {
    project: { name: system_name ?? name, domain, type, vision, goals, platforms: form_factor, release_scope },
    actors: take(spine.actors, ({ name: actor, kind }) => ({ name: actor, kind })),
    features: take(spine.features, (f) => f.name),
    nfrs: take(spine.nfrs, ({ category, statement }) => ({ category, statement })),
    common_requirements: take(spine.common_requirements, ({ category, statement }) => ({ category, statement })),
    business_rules: take(spine.business_rules.filter((r) => r.tier === "high"), (r) => r.statement),
    other_requirements: take(spine.other_requirements, ({ kind, statement }) => ({ kind, statement }))
  }
}

/** Chữ hướng dẫn mẫu để lại trong mục riêng (`[Describe …]`, `{…}`, kể cả trong câu — FLF-364) — ý khách muốn viết gì. */
const customGuidance = (blocks: Spine["custom_sections"][number]["blocks"]): string =>
  blocks
    .flatMap((b) => splitInstruction(b.text).guidance)
    .join(" ")
    .slice(0, 2000)

/**
 * FLF-278: mục riêng (`custom_sections`, heading mẫu không có mục FlintFlow tương ứng) mà lệnh nhắc theo id hoặc tiêu đề —
 * kèm nội dung hiện có và hướng dẫn của mẫu. Không có dòng này model không biết mục tồn tại, đoán ghi vào collection khác.
 */
const referencedCustomSections = (spine: Spine, haystack: string) =>
  spine.custom_sections
    .filter((c) => haystack.includes(c.id.toLowerCase()) || (c.heading.trim().length >= MIN_NAME_MATCH && haystack.includes(c.heading.trim().toLowerCase())))
    .slice(0, PROJECTION_ELEMENT_LIMIT)
    .map((c) => {
      const guidance = customGuidance(c.blocks)
      return { ...c, ...(guidance ? { guidance } : {}) }
    })

/** Lệnh áp cho cả một loại phần tử: "toàn bộ thông báo", "tất cả quy tắc", "mọi NFR", "all messages". */
const WHOLE_COLLECTION_HINT = /toàn bộ|tất cả|mọi |từng |cả \d+|\ball\b|\bevery\b|\beach\b/i

/** Tên gọi của loại phần tử trong câu lệnh ⇒ collection. */
const COLLECTION_NAME_HINTS: readonly [(typeof TARGET_COLLECTIONS)[number], RegExp][] = [
  ["messages", /thông báo|\bmessages?\b|\bmsg\b/i],
  ["business_rules", /quy tắc nghiệp vụ|business rules?/i],
  ["nfrs", /phi chức năng|\bnfrs?\b|non-functional/i],
  ["common_requirements", /yêu cầu chung|common requirements?/i],
  ["other_requirements", /yêu cầu khác|other requirements?/i],
  ["glossary", /thuật ngữ|glossary/i],
  ["actors", /\bactors?\b|tác nhân/i],
  ["use_cases", /use cases?|ca sử dụng/i]
]

/** Lệnh nói về mục tiêu / tầm nhìn / phạm vi phát hành của §1 Tổng quan sản phẩm. */
const PROJECT_OVERVIEW_HINT = /mục tiêu|muc tieu|tầm nhìn|tam nhin|phạm vi phát hành|trong phạm vi|ngoài phạm vi|tổng quan sản phẩm|product overview|\bgoals?\b|\bvision\b|release scope|in scope|out of scope/i

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

  // FLF-428: lệnh "Sửa trong chat" từ một cờ ⇒ model thấy cờ + gợi ý sửa theo luật, và field tuỳ chọn còn trống của phần tử
  // (NFR thiếu `metric` / `threshold` không có hai khoá đó trong object ⇒ model không biết chúng tồn tại)
  const targetFlags = targetFlagsOf(spine, instruction)
  if (targetFlags.length > 0) {
    projection.target_flags = targetFlags
    for (const t of targetFlags.filter((x) => x.rule_id === "nfr_missing_number")) {
      const nfr = spine.nfrs.find((n) => n.id === t.target_id)
      if (!nfr) continue
      const rest = ((projection.nfrs as Record<string, unknown>[] | undefined) ?? []).filter((n) => n.id !== nfr.id)
      projection.nfrs = [{ ...nfr, metric: nfr.metric ?? null, threshold: nfr.threshold ?? null }, ...rest]
      matched += 1
    }
  }

  // P08 (E2E P07 #1): "bổ sung loại và ngữ cảnh cho toàn bộ 46 thông báo" — lệnh cho CẢ một loại phần tử mà không nhắc số mục
  // ⇒ trước đây model chỉ thấy vài thông báo khớp chữ (2/46) và hỏi lại. Gọi tên loại + "toàn bộ / tất cả / mọi" ⇒ đưa cả loại
  if (WHOLE_COLLECTION_HINT.test(haystack)) {
    for (const [collection, re] of COLLECTION_NAME_HINTS) {
      if (!re.test(haystack)) continue
      const list = spine[collection] as unknown as Record<string, unknown>[]
      if (!Array.isArray(list) || list.length === 0) continue
      projection[collection] = list.slice(0, SECTION_ELEMENT_LIMIT)
      matched += Math.min(list.length, SECTION_ELEMENT_LIMIT)
    }
  }

  const permissions = permissionRows(spine, haystack, projection)
  if (permissions.length > 0) {
    projection.permissions = permissions
    existingIds.permissions = spine.permissions.map((p) => p.id).slice(0, 200)
    // Dòng phân quyền chỉ mang id ⇒ kèm tên vai trò/màn (gọn) để model đọc được "S01/R04" là Login/Guest
    if (!projection.roles) projection.roles = spine.roles.map(({ id, name, actor_id }) => ({ id, name, actor_id }))
    if (!projection.screens) projection.screens = spine.screens.slice(0, PERMISSION_ROW_LIMIT).map(({ id, name }) => ({ id, name }))
    matched += permissions.length
  }

  const customSections = referencedCustomSections(spine, haystack)
  if (customSections.length > 0) {
    projection.custom_sections = customSections
    projection.draft_context = draftContextOf(spine)
    matched += customSections.length
  }
  if (spine.custom_sections.length > 0) existingIds.custom_sections = spine.custom_sections.map((c) => c.id).slice(0, 200)

  // Pha Brief: tầm nhìn/mục tiêu là entry addendum lõi (ngôn ngữ user + bản EN) — model sửa ở đó, không ở project
  if (isInBriefPhase(spine)) {
    const core = briefCoreEntries(spine)
    const entries = [...(core.vision ? [core.vision] : []), ...core.goals]
    if (entries.length > 0) projection.brief_core = entries.map(({ id, topic, content, content_en }) => ({ id, topic, content, content_en }))
  }

  // FLF-411 (#18): "đổi tên hệ thống thành …" — thiếu `project` model đoán `project.name` (tên dự án). Luôn kèm hai tên
  // (gọn, không cả `project`) để model thấy `system_name` là field đang hiện ở tiêu đề / tên file.
  // P08 (T6/T7): lệnh sửa §1 / mục tiêu / tầm nhìn ngoài pha Brief — model phải thấy `project.goals` (mảng chuỗi, sửa cả mảng),
  // nếu không nó đoán chữ từ bản dịch tiếng Việt trong chat, trỏ `[1]` / `[=<chữ dịch>]` chết hoặc hỏi lại "chưa thấy mục tiêu"
  const aboutOverview = !projection.brief_core && (referencedSections(haystack).includes("fixed:1") || PROJECT_OVERVIEW_HINT.test(haystack))
  const project = {
    name: spine.project.name,
    system_name: spine.project.system_name ?? null,
    ...(aboutOverview ? { vision: spine.project.vision, goals: spine.project.goals, release_scope: spine.project.release_scope } : {})
  }

  if (matched > 0) return { project, ...projection, existing_ids: existingIds }

  const index: Record<string, unknown> = {}
  for (const collection of TARGET_COLLECTIONS) {
    const list = spine[collection] as unknown as Record<string, unknown>[]
    if (!Array.isArray(list) || list.length === 0) continue
    index[collection] = list.slice(0, PROJECTION_ELEMENT_LIMIT).map((element) => ({ id: element.id, label: textOf(element) }))
  }
  if (spine.custom_sections.length > 0) {
    index.custom_sections = spine.custom_sections.slice(0, PROJECTION_ELEMENT_LIMIT).map(({ id, heading }) => ({ id, label: heading }))
  }
  return { project, ...index, ...(projection.brief_core ? { brief_core: projection.brief_core } : {}), existing_ids: existingIds }
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

/**
 * Câu hỏi khi kết bằng "?" hoặc vế đầu (tới dấu phẩy / chấm đầu tiên) có dấu hiệu hỏi. Dấu hiệu ở vế sau chỉ là lời giải
 * thích kèm lệnh: "Đổi mô tả UC-03, vì sao khách hay quên pass thì ghi rõ" vẫn là lệnh sửa (trước đây "vì sao" ở bất kỳ
 * đâu chặn luôn, lệnh bị bỏ). Lệnh lịch sự kết bằng "?" ("Thêm nút xuất Excel được không?") do lượt chat bắt lại qua
 * `edit_request` (`project/chat-session.service.ts`).
 */
const isQuestion = (text: string): boolean => {
  if (text.endsWith("?")) return true
  const firstClause = text.split(/[,.;:!\n]/u)[0] ?? text
  return QUESTION_MARKERS.some((marker) => firstClause.includes(marker)) || QUESTION_WORDS.test(firstClause)
}

/** Số từ đầu câu được xét — "đổi tên actor A01" nhận, "tôi nghĩ là nên đổi" thì không. */
export const CHANGE_VERB_WINDOW = 4

/**
 * Tin nhắn ở session KHÔNG pipeline có phải lệnh sửa SRS không (Phases §2.3: mọi sửa đổi đi qua
 * change flow, kể cả gõ từ một session hỏi đáp). Không nhận ⇒ vẫn là CHAT thường.
 */
export const isChangeInstruction = (message: string): boolean => {
  const text = message.trim().toLowerCase()
  if (text.length === 0) return false
  if (isQuestion(text)) return false
  const words = text.split(/\s+/).map((word) => word.replace(/[^\p{L}]/gu, ""))
  const lead = words[0] === "please" ? words[1] : words[0]
  if (lead !== undefined && LEADING_CHANGE_VERBS.includes(lead)) return true
  if (words.slice(0, CHANGE_VERB_WINDOW).some((word) => CHANGE_VERBS.includes(word))) return true
  // P08: "Trong §1 Tổng quan sản phẩm, mục tiêu đầu tiên đổi thành: …" — câu mở bằng chỗ cần sửa rồi mới tới động từ ⇒ xét
  // cửa sổ sau dấu phẩy đầu tiên; "X đổi thành Y" / "thay bằng" ở bất cứ đâu cũng là lệnh sửa (trước đây rơi vào CHAT thường,
  // AI chỉ dặn "gõ câu lệnh sửa" và lệnh bị bỏ)
  if (RESULTATIVE_EDIT.test(text)) return true
  const comma = text.indexOf(",")
  if (LOCATOR_LEAD.test(text) && comma > 0) {
    const rest = text.slice(comma + 1).trim().split(/\s+/).map((word) => word.replace(/[^\p{L}]/gu, ""))
    return rest.slice(0, CHANGE_VERB_WINDOW + 2).some((word) => CHANGE_VERBS.includes(word))
  }
  return false
}

/** "… đổi thành …", "… sửa lại thành …", "… thay bằng …", "… change it to …". */
const RESULTATIVE_EDIT = /(?<!\p{L})(?:đổi|sửa|thay|chỉnh|chuyển)(?:\s+lại)?\s+(?:thành|sang|bằng)(?!\p{L})|\b(?:change|rename)\b[^.?!]{0,60}\bto\b/u

/** Câu mở bằng chỗ cần sửa: "Trong §1 …,", "Ở mục 5.3,", "Tại màn Login,". */
const LOCATOR_LEAD = /^(?:trong|ở|tại|với|in|on|for)\s/u

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
  /** P12: người sửa gần nhất của một chỗ (màn so sánh, câu "đã được … sửa giống"); thiếu ⇒ đọc `changes`. */
  lastEditor?: LastEditor
  /** Hồ sơ luật của dự án cho lượt dự báo cờ đỏ; thiếu ⇒ `ruleProfileOf` (chế độ 1 / mẫu bắt buộc), unit test không nối Mongo ⇒ không hồ sơ. */
  ruleProfile?: (projectId: string) => Promise<RuleProfile | undefined>
}

/** Nạp muộn như `defaultLastEditor`: `spine/` không kéo module import lúc load; không có Mongo ⇒ chạy đủ luật như chế độ 2. */
const defaultRuleProfile = async (projectId: string): Promise<RuleProfile | undefined> => {
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return undefined
  const { ruleProfileOf } = await import("../import/mode1-guard.js")
  return ruleProfileOf(projectId)
}

/** Path của phần use case (use case, màn, chức năng, quyền, thông báo) — lô sửa chạm tới thì vẽ lại sơ đồ. */
const USE_CASE_PARTS = /^(use_cases|screens|functions|permissions|messages)\[/

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
   * Nội bộ (DTO không nhận) — P08 (T7): yêu cầu gốc + câu hỏi làm rõ gần nhất khi lượt này là câu trả lời
   * (`pendingChangeRequest` của phiên). Model đọc lượt như "yêu cầu gốc, đã hỏi, user trả lời" thay vì một lệnh đứng một mình.
   */
  pending_request?: { request: string; question: string } | null
  /**
   * Nội bộ (DTO `strictObject` không nhận — client không gửi được bản dịch, D7): lô `ops` do server gom (hoà giải) kèm chữ
   * theo ngôn ngữ tài liệu model trả cùng lô, và ngôn ngữ của lượt đó. Đi theo preview tới lượt áp.
   */
  localized?: LocalizedEntry[]
  document_language?: TurnLanguagePair | null
  /**
   * Nội bộ (DTO không nhận) — P12: lượt áp bản xem trước mà có chỗ người khác vừa sửa đúng chữ. `reject` (mặc định, sửa qua
   * chat) ⇒ 409 kèm màn so sánh, không ghi gì; `skip` (hoà giải, chốt câu 9) ⇒ bỏ chỗ đó, ghi các chỗ khác.
   */
  on_conflict?: "reject" | "skip"
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
  /** FLF-318: ý của lệnh về use case (gồm cả câu hỏi làm rõ trước đó). */
  intent?: UseCaseIntent | null
  /** AI cho rằng yêu cầu không hợp lý (ngôn ngữ trả lời): bản xem trước hiện cảnh báo + nút "Vẫn làm". */
  warning?: string
  /** Chỗ AI tự đoán vì yêu cầu chưa nói rõ — ghi vào `spine.assumptions` cùng lô, nói thẳng trong lời trả lời. */
  assumptions?: ChatAssumption[]
}

/** Model gửi field không có trong Spine (`screens[].authorized_role_ids`) — nhắc nó chỉ dùng field thấy trong projection. */
const SCHEMA_FIX =
  "Lô bị từ chối: chỉ ghi vào field có trong projection. Phân quyền màn hình là các dòng permissions[] {screen_id, role_id, action} " +
  "- thêm dòng để cấp quyền, remove permissions[id=…] để thu quyền; không có field nào kiểu authorized_role_ids trên screens[]"

/**
 * Lỗi của lô model vừa trả, để gọi lại model một lần kèm lỗi:
 * - lô không áp thử được (sai schema, phá bất biến) ⇒ các violation;
 * - FLF-243: tên use case model TỰ đặt mà cờ vàng `usecase_name_*` sẽ bắt. Tên user gõ nguyên văn thì để yên.
 */
/** Lệnh thêm use case có màn: phần giao diện còn thiếu của các use case mới (lô không áp thử được ⇒ để lỗi bất biến lo). */
const screenIssuesOf = (spine: Spine, ops: Op[], ucMode: UseCaseMode | null, allowShared: boolean, uiPlan: readonly UiPlanEntry[] = [], newUseCase = true) => {
  if (ops.length === 0 || (ucMode !== "screen_pending" && ucMode !== "full")) return { screen: [], plan: [] }
  try {
    const planned = planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 })
    const expectUseCase = newUseCase && !(uiPlan.length > 0 && uiPlan.every((e) => e.drop))
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

/** Lô áp thử được trên Spine (không phá schema, bất biến). */
const canPlan = (spine: Spine, ops: Op[]): boolean => {
  try {
    planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 })
    return true
  } catch (err) {
    if (err instanceof TransactionRejectedError) return false
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
  removesUseCase = false,
  /** FLF-318: lệnh sửa use case ⇒ đổi actor thì quyền trên màn của use case đổi theo (luật 3h). */
  editsUseCase = false
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
  const ui = screenIssuesOf(spine, ops, ucMode, allowShared, uiPlan, !editsUseCase)
  const screens = [...ui.screen.map(useCaseScreenProblemText), ...ui.plan.map(uiPlanProblemText)]
  const leftovers = removesUseCase ? removalLeftovers(spine, plan.spine).map(removalProblemText) : []
  const edits = editsUseCase ? editIssues(spine, plan.spine).map(editProblemText) : []
  // FLF-428: lệnh nhắm một cờ mà lô không đóng được cờ đó ⇒ một lượt thử lại kèm gợi ý sửa đúng field
  const flagsLeft = unresolvedAfter(targetFlagsOf(spine, instruction), plan.spine).map(unresolvedProblemText)
  // Mục riêng của mẫu do AI soạn: bảng đúng cột của mẫu, không từ mơ hồ
  const drafted = sectionDraftProblems(spine, plan.spine, instruction)
  return [...(naming.length > 0 ? [...naming, USE_CASE_NAME_FIX] : []), ...screens, ...leftovers, ...edits, ...flagsLeft, ...drafted]
}

/** FLF-318: phần lô sửa use case còn bỏ sót (lô không áp thử được ⇒ để lỗi bất biến lo). */
const editIssuesOf = (spine: Spine, ops: Op[]): EditIssue[] => {
  if (ops.length === 0) return []
  try {
    return editIssues(spine, planTransaction(spine, { base_version: spine.spine_version, ops, by: "change-preview", step_id: null }, { startSeq: 1 }).spine)
  } catch (err) {
    if (err instanceof TransactionRejectedError) return []
    throw err
  }
}

/** Model trả output sai khuôn (không op, không câu hỏi) ⇒ hỏi lại user thay vì đẩy lỗi Zod tiếng Anh ra giao diện. */
const UNCLEAR_INSTRUCTION: Readonly<Record<ReplyLanguage, string>> = {
  vi:
    "Mình chưa xác định được cần đổi gì trong tài liệu. Bạn nói rõ mục và nội dung muốn đổi giúp mình " +
    "(ví dụ: \"thêm quyền view màn Login cho Teacher\"). Sơ đồ được vẽ lại tự động từ dữ liệu - muốn vẽ lại ngay thì bấm \"Vẽ lại sơ đồ\" dưới hình.",
  en:
    "I couldn't tell what to change in the document. Please tell me which section and what content you want to change " +
    "(for example: \"add view permission on the Login screen for Teacher\"). Diagrams are redrawn automatically from the data - " +
    "to redraw one right away, press \"Vẽ lại sơ đồ\" (Redraw diagram) below it."
}

const AI_OUTPUT_ERRORS = new Set(["SCHEMA_MISMATCH", "PARSE_FAILED"])

/**
 * Câu lệnh tự nhiên → lô op, hoặc một câu hỏi làm rõ (UC 6.11). Một lượt gọi model; lô có lỗi (áp thử bị từ chối, tên
 * use case sai luật — FLF-243) thì gọi lại đúng MỘT lần kèm lỗi — lần hai vẫn sai thì giữ lô để preview báo lỗi / cờ vàng bắt.
 */
/** Câu rút lại yêu cầu đang dở — chỉ xét khi đang trả lời câu hỏi. Luật ở `shared/i18n/withdrawal.ts` (FLF-439). */
export { isWithdrawal }
const WITHDRAWN = {
  vi: "Đã bỏ yêu cầu này - tài liệu không đổi gì. Khi cần, bạn cứ nhắn yêu cầu mới.",
  en: "Dropped this request - nothing in the document changed. Send a new request whenever you need."
}

/**
 * P08 (T7): câu trả lời cho câu hỏi làm rõ ("Đúng, thêm mốc 3 tháng") không phải lệnh đứng một mình — ghép yêu cầu gốc và
 * câu đã hỏi vào `user_message`. Trước đây chỉ câu trả lời tới model (yêu cầu gốc nằm lẫn trong lịch sử) ⇒ model không ra
 * lô nào ⇒ "Mình chưa xác định được cần đổi gì".
 */
export const answeredMessage = (answer: string, pending: { request: string; question: string } | null): string =>
  pending && pending.request !== answer.trim()
    ? [
        `Original request: ${pending.request}`,
        `You asked: ${pending.question}`,
        `User's answer: ${answer}`,
        // E2E P08: câu hỏi thường trích chữ tài liệu ĐÃ DỊCH sang tiếng Việt ⇒ model đi tìm đúng chữ đó trong projection tiếng
        // Anh, không thấy ⇒ hỏi lại / trỏ selector chết
        "Apply the answer to the original request now and return the batch. Your question may quote document text in the user's language - match it to the projection element by meaning, never by that quoted wording."
      ].join("\n")
    : answer

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
  interactive = true,
  /** P08 (T7): lượt trả lời câu hỏi làm rõ — yêu cầu gốc + câu đã hỏi đi cùng câu trả lời trong `user_message`. */
  pending: { request: string; question: string } | null = null
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
  // FLF-318: lệnh sửa use case ⇒ phần chỉ thuộc nó sửa theo, phần dùng chung hỏi trước (luật 3h); lô sửa có thể thêm use
  // case / màn (thêm bước do actor khác làm) ⇒ vẫn chạy luật 3e + chuẩn hoá của lệnh thêm
  const intent = useCaseIntent(instruction) ?? (clarificationRounds > 0 ? useCaseIntent(history) : null)
  const removesUseCase = intent === "remove"
  const editsUseCase = intent === "edit"
  const addsUseCase = !removesUseCase && !editsUseCase && (isAddUseCaseInstruction(instruction) || (clarificationRounds > 0 && isAddUseCaseInstruction(history)))
  const ucMode = addsUseCase || editsUseCase ? useCaseMode(spine) : null
  const ucUi = ucMode === "screen_pending" || ucMode === "full"
  // FLF-311: câu trả lời cho câu hỏi giao diện ⇒ kế hoạch từng use case (màn riêng / popup / màn có sẵn / dùng chung)
  // Đọc bằng luật trước (đưa model làm cách đọc tạm); model trả `ui_plan` của chính nó ⇒ dùng bản đó (`adoptModelPlan`)
  const asked = ucUi ? askedList(history) : []
  let uiPlan = ucUi ? uiPlanFor(instruction, history) : []
  // Có kế hoạch ⇒ dùng chung hay không do kế hoạch kiểm; không có ⇒ user nói "dùng chung" thì không nhắc tách màn
  let allowShared = ucMode !== null && (uiPlan.length > 0 || wantsSharedScreen(instruction, history))
  const adoptModelPlan = (data: { ui_plan?: Parameters<typeof uiPlanFromModel>[0] }): void => {
    const fromModel = uiPlanFromModel(data.ui_plan, asked)
    if (!fromModel) return
    uiPlan = fromModel
    allowShared = ucMode !== null
  }
  // Op chỉ số trên mảng chuỗi (`normal[2]`) ⇒ set cả mảng (op engine cấm chỉ số)
  const prepare = (ops: Op[]): Op[] =>
    stampChatSource(applyUiPlan(expandIndexSelectors(spine, ucMode ? normalizeUseCaseBatch(spine, stampAddendum(ops)) : stampAddendum(ops)), uiPlan))
  // FLF-265 D16: một lần cho cả lượt (kể cả lượt gọi lại kèm lỗi)
  const language = await (deps.documentLanguage ?? documentLanguageForTurn)(projectId)
  const call = (previousProblems?: string) =>
    deps.changeExecutor(
      ActionType.CHANGE_INSTRUCTION,
      {
        promptVariables: {
          call_kind: "change_instruction",
          user_message: answeredMessage(instruction, clarificationRounds > 0 ? pending : null),
          chat_history: history || "(none)",
          is_pipeline: false,
          has_baseline: spine.baselines.length > 0,
          // Câu trả lời cho câu hỏi làm rõ ("A03") thường không nhắc lại thực thể của yêu cầu gốc ⇒ dò cả đoạn hội thoại
          projection: {
            ...buildChangeProjection(spine, history ? `${history}\n${instruction}` : instruction),
            ...(ucMode
              ? {
                  use_case_context: {
                    ...useCaseContext(spine, ucMode),
                    // Câu hỏi giao diện đã hỏi (đánh số) ⇒ model tự đọc câu trả lời, trả `ui_plan` (luật 3e)
                    ...(asked.length ? { ui_asked: asked.map((u, i) => ({ index: i + 1, use_case: u.name, proposed: u.proposed })) } : {}),
                    ...(uiPlan.length ? { ui_plan: uiPlanForModel(uiPlan) } : {})
                  }
                }
              : {}),
            // Lệnh xoá: model cần thấy chức năng / màn / thông báo của mọi use case để biết phần nào chỉ thuộc use case bị xoá
            ...(removesUseCase ? { use_case_context: useCaseContext(spine, "full") } : {}),
            // Lệnh sửa: giá trị hiện tại của use case được nhắc + phần của nó (chức năng đủ luồng, màn, quyền, thông báo)
            ...(editsUseCase
              ? {
                  use_case_context: {
                    ...useCaseContext(spine, "full"),
                    edit_targets: useCaseEditContext(spine, history ? `${history}\n${instruction}` : instruction)
                  }
                }
              : {})
          },
          use_case_mode: ucMode ?? "none",
          use_case_removal: removesUseCase,
          use_case_edit: editsUseCase,
          use_case_ui: ucMode === "screen_pending" || ucMode === "full",
          messages_ready: ucMode === "full" && messagesReady(spine),
          glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
          stale_sections: [],
          // Điều người dùng đã chốt (sổ quyết định): yêu cầu trái chúng ⇒ model trả `warning`, không tự làm
          decisions: [...activeDecisions(spine).values()].slice(-20).map(({ topic_key, question, answer }) => ({ topic_key, question, answer })),
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
    adoptModelPlan(result.data)
  } catch (err) {
    if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) {
      return { ops: [], clarification: byLanguage(replyLanguage ?? DEFAULT_REPLY_LANGUAGE, UNCLEAR_INSTRUCTION), notes: null }
    }
    throw err
  }
  // FLF-299: đã hỏi đủ mà model vẫn hỏi ⇒ gọi lại MỘT lần, bắt soạn từ câu trả lời của user + projection
  if (result.data.clarification_needed?.trim() && clarificationRounds >= MAX_CLARIFICATION_ROUNDS) {
    const forced = await call(
      `You already asked ${clarificationRounds} clarifying questions for this request and the user answered them. Do not ask again: draft the batch now from those answers and the projection (rule 2a). Everything you had to guess goes in \`assumptions\` (rule 2d).`
    ).catch((err: unknown) => {
      if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) return null
      throw err
    })
    if (forced && !forced.data.clarification_needed?.trim() && (forced.data.ops ?? []).length > 0) {
      result = forced
      adoptModelPlan(forced.data)
    }
  }
  // Lô sai thì gọi lại kèm lỗi: một lần; có kế hoạch giao diện (lệnh nhiều use case, 3–4 màn) thì tới hai lần
  for (let attempt = 0, max = uiPlan.length > 0 ? 2 : 1; attempt < max && !result.data.clarification_needed?.trim(); attempt++) {
    const problems = batchProblems(spine, prepare((result.data.ops ?? []) as Op[]), instruction, ucMode, allowShared, uiPlan, removesUseCase, editsUseCase)
    if (problems.length === 0) break
    const retry = await call(problems.join("\n")).catch((err: unknown) => {
      if (err instanceof AiActionError && AI_OUTPUT_ERRORS.has(err.code)) return null
      throw err
    })
    if (!retry || retry.data.clarification_needed?.trim() || (retry.data.ops ?? []).length === 0) break
    result = retry
    adoptModelPlan(retry.data)
  }

  // Câu hỏi làm rõ và ghi chú preview hiện thẳng cho user: mã phần tử model còn chép (`S02`) đổi sang tên
  const clarification = result.data.clarification_needed?.trim()
  const choices = result.data.choices?.length ? { choices: result.data.choices.map((c) => nameElementIds(c, spine)) } : {}
  if (clarification) {
    // Lệnh nhiều ý: ý rõ đã ra op, ý mơ hồ gom vào MỘT câu hỏi. Lô một phần phải áp thử được, không thì chỉ còn câu hỏi như trước.
    const partial = prepare((result.data.ops ?? []) as Op[])
    const usable = partial.length > 0 && canPlan(spine, partial)
    return {
      ops: usable ? partial : [],
      clarification: nameElementIds(clarification, spine),
      notes: usable && result.data.notes ? nameElementIds(result.data.notes, spine) : null,
      ...(usable && result.data.localized?.length ? { localized: result.data.localized, language: languagePairOf(language) } : {}),
      ...choices
    }
  }
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
  const left = screenIssuesOf(spine, ops, ucMode, allowShared, uiPlan, !editsUseCase)
  const noteLanguage = replyLanguage ?? DEFAULT_REPLY_LANGUAGE
  const leftovers = removesUseCase ? removalNote(removalLeftoversOf(spine, ops), noteLanguage) : editsUseCase ? editNote(editIssuesOf(spine, ops), noteLanguage) : null
  const notes =
    [result.data.notes ? nameElementIds(result.data.notes, spine) : null, useCaseScreenNote(left.screen, noteLanguage), uiPlanNote(left.plan, noteLanguage), leftovers]
      .filter(Boolean)
      .join("\n") || null
  const localized = result.data.localized?.length ? { localized: result.data.localized } : {}
  const proposed = result.data.proposed_use_cases?.length ? { proposed: [...result.data.proposed_use_cases] } : {}
  const warning = result.data.warning?.trim() ? { warning: nameElementIds(result.data.warning.trim(), spine) } : {}
  const assumptions = result.data.assumptions?.length ? { assumptions: result.data.assumptions.map((a) => ({ ...a })) } : {}
  return { ops, clarification: null, notes, ...localized, ...proposed, ...warning, ...assumptions, intent, language: languagePairOf(language) }
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
  return await opsFromInstruction(
    projectId,
    userId,
    spine,
    body.instruction,
    body.chat_history,
    body.reply_language,
    deps,
    body.clarification_rounds,
    true,
    body.pending_request ?? null
  )
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
   * AI cho rằng yêu cầu không hợp lý (kèm lý do, ngôn ngữ trả lời). Có ⇒ không tự ghi; áp dụng bản xem trước này là "Vẫn làm"
   * (giữ ý sau cảnh báo, lưu vào phiên chat cho lượt kiểm sau đọc).
   */
  warning?: string
  /** Cờ đỏ mới mà bản sửa sẽ mở (Code chạy deterministic check trước / sau). Có ⇒ "sửa này sẽ chặn baseline". */
  predicted_red_flags?: PredictedRedFlag[]
  /** Chỗ AI tự đoán, đã ghi vào giả định của tài liệu cùng lô; lời trả lời (`notes`) đã nói giả định thẳng. */
  assumptions?: { statement: string; statement_vi?: string }[]
  /** Bản sửa đã được tự ghi ngay (mức duyệt cho phép, không dính cổng cứng) — hoàn tác được, tính vào "Chưa xem". */
  auto_applied?: boolean
  /** `spine_version` sau khi tự ghi. */
  applied_version?: number
  /** Lý do vẫn chờ người dùng xác nhận dù là lệnh sửa chat trước baseline (mức Mọi bước, cổng cứng, cảnh báo, câu hỏi). */
  confirm_reason?: string
  /** Nội bộ: bản xem trước đủ điều kiện tự ghi (`previewAndMaybeApply` đọc, controller bỏ đi). */
  auto_apply_ok?: boolean
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
  // P12 (BF §3.2): xem trước chỉ đọc và luôn dựng trên Spine hiện tại ⇒ người khác vừa ghi không làm hỏng lượt xem trước;
  // lượt áp kiểm lại theo nội dung từng chỗ (`places`), không theo version cả tài liệu.
  if (record.spine_version !== body.base_version) body = { ...body, base_version: record.spine_version }
  assertDraftUnlocked(record)
  const spine = stripRecord(record)

  const resolved = await resolveOps(projectId, userId, spine, body, d)
  // Lệnh nhiều ý: ý rõ đã ra op, ý mơ hồ nằm trong câu hỏi - bản xem trước vẫn dựng cho phần rõ, kèm câu hỏi
  const partial = resolved.clarification !== null && resolved.ops.length > 0
  const clarifyOnly = (): ChangePreviewResult => ({
    ...rejectedPreview(body.base_version, []),
    clarification: resolved.clarification ?? "",
    ...(resolved.choices?.length ? { clarification_choices: resolved.choices } : {})
  })
  if (resolved.clarification !== null && !partial) return clarifyOnly()
  if (resolved.withdrawn) return { ok: true, txn: randomUUID(), base_version: body.base_version, ops: [], changes: [], violations: [], referrers: [], notes: resolved.notes ?? undefined }
  if (resolved.ops.length === 0) {
    return { ...rejectedPreview(body.base_version, [{ rule: "op_value_missing", message: "Không có thay đổi nào để xem trước" }]) }
  }

  const notWritable = notWritableViolations(resolved.ops, spine)
  if (notWritable.length > 0) return rejectedPreview(body.base_version, notWritable)

  const txnId = randomUUID()
  // Giả định ghi cùng lô như step làm (undo cùng lô). Giả định có path chết làm lô bị từ chối ⇒ bỏ riêng chúng, vẫn ghi phần chính.
  const extraOps = assumptionOps(spine, resolved.assumptions ?? [])
  let ops = [...resolved.ops, ...extraOps]
  let plan
  try {
    plan = planTransaction(spine, toTransaction(userId, body, ops, txnId), { startSeq: 1 })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    try {
      if (extraOps.length === 0) throw err
      ops = resolved.ops
      plan = planTransaction(spine, toTransaction(userId, body, ops, txnId), { startSeq: 1 })
    } catch (inner) {
      if (!(inner instanceof TransactionRejectedError)) throw inner
      if (partial) return clarifyOnly()
      return { ...rejectedPreview(body.base_version, inner.violations, inner.referrers), txn: txnId }
    }
  }
  const recordedAssumptions = ops.length > resolved.ops.length ? (resolved.assumptions ?? []) : []

  // Mục riêng do AI soạn: bảng sai cột / từ mơ hồ còn sót sau lượt thử lại ⇒ không cho xác nhận (luật tầng 3 là cổng cứng)
  if (body.ops === undefined && body.instruction !== undefined) {
    const drafted = sectionDraftProblems(spine, plan.spine, body.instruction)
    if (drafted.length > 0) {
      return { ...rejectedPreview(body.base_version, drafted.map((message) => ({ rule: "schema_invalid" as const, message }))), txn: txnId }
    }
  }

  const shownChanges = plan.changes.filter((c) => !c.path.startsWith("assumptions"))
  const impact = impactOfChanges(spine, shownChanges, plan.spine)
  const branch = branchOf(spine, impact)

  // Dự báo cờ đỏ: Code chạy deterministic check trước / sau trên Spine của lô, không tin lời AI
  const language = body.reply_language ?? DEFAULT_REPLY_LANGUAGE
  const profile = await (d.ruleProfile ?? defaultRuleProfile)(projectId)
  const predicted = predictRedFlags(spine, plan.spine, profile)
  // Sửa qua chat bằng câu lệnh, trước baseline: mức duyệt quyết định thẻ xác nhận hay tự ghi (sau baseline đi đường change request)
  const chatEdit = body.instruction !== undefined && body.ops === undefined && branch !== "post_baseline"
  const verdict = chatEdit
    ? chatEditVerdict({
        reviewMode: spine.project.review_mode ?? "balanced",
        touchedSections: impact.sections.filter((s) => s.relation === "owner").map((s) => s.id),
        redDelta: predicted.length,
        contentRemoved: shownChanges.some((c) => c.op === "remove"),
        newAssumptions: recordedAssumptions.map((a, i) => ({ id: `chat-${i + 1}`, text: a.statement, ...(a.statement_vi ? { text_vi: a.statement_vi } : {}) })),
        needsPerson: Boolean(resolved.warning) || partial,
        spine
      })
    : null
  // FLF-298: use case mới chưa có chức năng/màn hình — sửa không tự lan, báo ngay để author yêu cầu tiếp
  // FLF-311: use case mới chồng mục tiêu với use case có sẵn cùng actor ⇒ cảnh báo (lưới an toàn sau luật 3e)
  const notes = [
    resolved.notes,
    newUseCaseGapNote(newUseCaseGaps(spine, plan.spine), body.reply_language),
    useCaseOverlapNote(useCaseOverlaps(spine, plan.spine), body.reply_language),
    predictedRedNote(predicted, language),
    assumptionsNote(recordedAssumptions, language)
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
    ops,
    reason: body.reason ?? null,
    impact,
    branch,
    ...(resolved.localized?.length ? { localized: resolved.localized, language: languagePairOf(resolved.language) } : {}),
    use_case_intent: resolved.intent ?? null,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    ...(partial ? { request_open: true } : {}),
    places: placesOf(spine, plan.spine, ops.filter((o) => !o.path.startsWith("assumptions"))),
    created_at: Date.now(),
    expires_at: Date.now() + PREVIEW_TTL_MS
  })

  return {
    ok: true,
    txn: txnId,
    base_version: body.base_version,
    ops: plan.ops.filter((o) => !o.path.startsWith("assumptions")),
    changes: shownChanges.map(({ op, path, before, value, reason }) => ({ op, path, before, value, reason })),
    violations: [],
    referrers: impact.referrers,
    branch,
    impact,
    preview_id: previewId,
    ...(notes ? { notes } : {}),
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    ...(predicted.length > 0 ? { predicted_red_flags: predicted } : {}),
    ...(recordedAssumptions.length > 0 ? { assumptions: recordedAssumptions.map(({ statement, statement_vi }) => ({ statement, ...(statement_vi ? { statement_vi } : {}) })) } : {}),
    ...(partial ? { clarification: resolved.clarification ?? "", ...(resolved.choices?.length ? { clarification_choices: resolved.choices } : {}) } : {}),
    ...(verdict ? (verdict.quiet ? { auto_apply_ok: true } : { confirm_reason: verdict.reason_vi }) : {})
  }
}

export interface ChangeApplyResult extends ApplyResult {
  branch: ChangeBranch
  impact: Impact
  /** FLF-294: mã change request của lượt áp sau baseline; trước baseline / hoà giải ⇒ `null`. */
  cr_id?: string | null
  /** FLF-428: cờ mà câu lệnh nhắm tới vẫn còn mở sau khi ghi (rỗng / thiếu ⇒ đã đóng hoặc lệnh không nhắm cờ nào). */
  unresolved_flags?: TargetFlag[]
  /** P12: chỗ người khác đã sửa giống đề xuất — không ghi lại. */
  already_applied?: PlaceSame[]
  /** P12 (`on_conflict: "skip"`): chỗ người khác vừa sửa đúng chữ — không ghi, bên gọi cho AI soạn lại. */
  skipped?: PlaceConflict[]
  /** Lời cảnh báo của AI mà người dùng đã chọn bỏ qua ("Vẫn làm") khi áp bản xem trước này — controller ghi vào phiên chat. */
  kept_warning?: string
  /** Bản xem trước vừa áp chỉ là phần rõ của lệnh nhiều ý; câu hỏi cho phần còn lại vẫn đang chờ. */
  request_open?: boolean
}

/**
 * FLF-318: ghi lại `accepted_at` cho step sở hữu các section mà lô thêm use case vừa duyệt (cùng lượt vẽ lại sơ đồ) làm
 * stale — một transaction riêng, lý do nội bộ (`gate:` ⇒ không vào §I). Lỗi chỉ ghi log: lô đã ghi, section còn stale thì
 * người dùng hoà giải như trước.
 */
const reacceptReviewedSections = async (
  projectId: string,
  userId: string,
  before: Spine,
  batch: readonly Change[],
  /** `owned`: chỉ section mà lô (và lượt vẽ lại) ghi vào dữ liệu thuộc nó — lô sửa use case. */
  scope: "all" | "owned" = "all"
): Promise<void> => {
  try {
    const firstSeq = Math.min(...batch.map((c) => c.seq))
    const [current, changes] = await Promise.all([repository.get(projectId), repository.listChanges(projectId)])
    if (!current) return
    const after = stripRecord(current)
    const only = scope === "owned" ? ownedSections(before, after, changes.filter((c) => c.seq >= firstSeq)) : undefined
    const ops = reacceptOps(before, changes.filter((c) => c.seq < firstSeq), after, changes, new Date().toISOString(), only)
    if (ops.length === 0) return
    await applyTransaction(projectId, {
      base_version: current.spine_version,
      ops,
      by: userId,
      step_id: null,
      reason: "gate: đã duyệt qua bản xem trước lô thêm use case"
    })
  } catch (err) {
    console.warn(`[change] ${projectId}: đánh dấu đã duyệt các section của lô thêm use case lỗi - section còn stale`, err)
  }
}

/**
 * Áp lô lên Spine trong một transaction, rồi `recomputeFlags` (deterministic check trên Spine mới ghi). KHÔNG kiểm cờ đỏ trước
 * khi ghi: dự báo cờ đỏ là việc của `preview` (`predicted_red_flags`). Lượt áp chỉ kiểm lại những gì đổi từ lúc xem trước: version,
 * chỗ người khác vừa sửa (`recheckPlaces`), bất biến (`planTransaction`), CR sau baseline.
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
  await assertNoMigrationRunning(projectId)
  const record = await loadSpine(projectId, init)
  // P12: có bản xem trước ⇒ kiểm lại theo nội dung từng chỗ (dưới); áp thẳng (không xem trước) vẫn khoá theo version
  if (body.preview_id === undefined) assertVersion(record, body.base_version)
  assertDraftUnlocked(record)
  const spine = stripRecord(record)
  // FLF-294 (BR-03): sau baseline lượt áp là một change request — kiểm TRƯỚC khi lấy bản xem trước (`takePreview` xoá
  // nó), để author thiếu người yêu cầu / nguồn điền rồi bấm lại vẫn còn bản xem trước. Hoà giải là việc kéo theo của CR.
  const crInfo = spine.baselines.length > 0 && !body.cr_exempt ? assertCrInfo(body.change_request) : null

  const stored = body.preview_id === undefined ? null : takePreview(projectId, body.preview_id)
  // FLF-428: cờ câu lệnh nhắm tới — tính trên Spine TRƯỚC khi ghi (sau khi ghi cờ có thể đã đóng)
  const targetFlags = targetFlagsOf(spine, stored?.instruction ?? body.instruction ?? null)
  const resolved: ResolvedOps = stored
    ? { ops: stored.ops, clarification: null, notes: null, ...(stored.localized ? { localized: stored.localized, language: languagePairOf(stored.language) } : {}) }
    : await resolveOps(projectId, userId, spine, body, d)

  // P12 (BF §3.2, chốt câu 8): người khác đã ghi từ lúc xem trước ⇒ kiểm từng chỗ trên nội dung hiện tại
  let drift: Recheck | null = null
  if (stored) {
    body = { ...body, base_version: record.spine_version }
    if (stored.base_version !== record.spine_version) {
      drift = await recheckPlaces(projectId, spine, stored, d.lastEditor ?? defaultLastEditor)
      if (drift.conflicts.length > 0 && body.on_conflict !== "skip") {
        restorePreview(body.preview_id!, stored)
        throw new ApiError(409, conflictMessage(drift.conflicts, body.reply_language), repository.SPINE_VERSION_CONFLICT, {
          spine_version: record.spine_version,
          conflicts: drift.conflicts,
          already_applied: drift.same,
          preview_id: body.preview_id,
          instruction: stored.instruction
        })
      }
      resolved.ops = drift.ops
      if (resolved.ops.length === 0) {
        // Mọi chỗ đã được người khác sửa giống đề xuất (hoặc hoà giải bỏ qua) ⇒ không ghi gì
        return {
          spine: record,
          changes: [],
          txn: null,
          spine_version: record.spine_version,
          branch: stored.branch,
          impact: stored.impact,
          cr_id: null,
          ...(drift.same.length ? { already_applied: drift.same } : {}),
          ...(drift.conflicts.length ? { skipped: drift.conflicts } : {})
        }
      }
    }
  }

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
  // Lô đã ghép lại trên Spine mới ⇒ tính lại phạm vi; bất biến vỡ (chỗ khác làm gãy tham chiếu) đã bị `planTransaction` từ chối
  const impact = stored && !drift ? stored.impact : impactOfChanges(spine, plan.changes, plan.spine)
  const branch = stored?.branch ?? branchOf(spine, impact)

  if (branch === "post_baseline" && (reason === undefined || reason.trim() === "")) {
    throw new ApiError(400, "Dự án đã có baseline - mọi thay đổi cần ghi lý do (vào Record of Changes)", "VALIDATION_ERROR")
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
  // FLF-318: xoá / sửa use case / màn cũng phải vẽ lại sơ đồ use case, screen flow (không để cờ `diagram_stale`)
  const editsUseCase = stored?.use_case_intent === "edit" && applied.changes.some((c) => USE_CASE_PARTS.test(c.path))
  if (applied.txn !== null && (addsUseCaseOrScreen(spine, applied.spine) || removesUseCaseOrScreen(spine, applied.spine) || editsUseCase)) {
    await d.renderAfterChange?.(projectId, userId, addedScreenIds(spine, applied.spine))
    // FLF-318: lô trọn gói (chỉ thêm / chỉ xoá phần của chính nó), người dùng đã duyệt ở bản xem trước ⇒ không bắt duyệt lại
    // các section nó (và lượt vẽ lại) làm stale. Lô sửa use case: chỉ gỡ section mà lô ghi vào phần dữ liệu THUỘC section
    // đó (người dùng đã duyệt chính nội dung ấy); section chỉ đọc dữ liệu bị sửa vẫn stale (văn xuôi của nó có thể đã cũ)
    if (stored && isSelfContainedBatch(spine, applied.spine, applied.changes)) await reacceptReviewedSections(projectId, userId, spine, applied.changes)
    else if (stored && editsUseCase) await reacceptReviewedSections(projectId, userId, spine, applied.changes, "owned")
  }
  // Cờ tính lại sau khi ghi: thay đổi của user có thể mở cờ đỏ mới (chặn baseline kế tiếp).
  if (applied.txn !== null) await d.recomputeFlags(projectId, userId)
  const after = await repository.get(projectId)
  const unresolved = after && applied.txn !== null ? stillOpenIn(targetFlags, after) : []

  return {
    ...applied,
    ...(after ? { spine: after, spine_version: after.spine_version } : {}),
    branch,
    impact,
    cr_id: crId,
    ...(unresolved.length > 0 ? { unresolved_flags: unresolved } : {}),
    ...(drift?.same.length ? { already_applied: drift.same } : {}),
    ...(drift?.conflicts.length ? { skipped: drift.conflicts } : {}),
    ...(stored?.warning ? { kept_warning: stored.warning } : {}),
    ...(stored?.request_open ? { request_open: true } : {})
  }
}

/**
 * Xem trước một lệnh sửa gõ trong chat; đủ điều kiện (`auto_apply_ok`: mức duyệt cho phép và không dính cổng cứng) thì ghi luôn
 * bằng chính bản xem trước đó. Bản tự ghi vẫn nằm trong `changes[]` nên undo được như mọi lượt sửa, và vào sổ "Chưa xem". Ghi lỗi
 * (người khác vừa sửa, lô vỡ bất biến) ⇒ trả lại bản xem trước chưa ghi để người dùng xác nhận như thường.
 */
export const previewAndMaybeApply = async (
  projectId: string,
  userId: string,
  body: ChangeBody,
  init: repository.SpineInit = {},
  deps: Partial<ChangeDeps> = {}
): Promise<ChangePreviewResult> => {
  const { auto_apply_ok: auto, ...result } = await preview(projectId, userId, body, init, deps)
  if (!auto || !result.preview_id || !result.ok) return result
  const previewId = result.preview_id
  const kept = previewStore.get(previewId)
  try {
    const applied = await apply(
      projectId,
      userId,
      { base_version: result.base_version, preview_id: previewId, ...(body.reply_language ? { reply_language: body.reply_language } : {}) },
      init,
      deps
    )
    if (applied.txn === null) return result
    const label = (body.instruction ?? "").trim().replace(/\s+/g, " ")
    await recordAutoPass(projectId, `chat:${applied.txn}`, "Sửa qua chat: mức duyệt cho phép tự ghi thay đổi này", label ? `Sửa qua chat: ${label.length > 80 ? `${label.slice(0, 77)}...` : label}` : "Sửa qua chat")
    const { preview_id: _consumed, ...rest } = result
    return { ...rest, auto_applied: true, applied_version: applied.spine_version }
  } catch (err) {
    if (!(err instanceof ApiError || err instanceof TransactionRejectedError)) throw err
    // Bản xem trước đã bị lấy đi (hoặc chưa kịp) ⇒ trả về kho để nút Áp dụng vẫn dùng được
    if (kept && !previewStore.has(previewId)) previewStore.set(previewId, kept)
    console.warn(`[change] ${projectId}: tự ghi bản sửa qua chat lỗi, chờ người dùng xác nhận`, err instanceof Error ? err.message : err)
    return { ...result, confirm_reason: "Chưa tự ghi được (tài liệu vừa đổi) - xem lại rồi bấm Áp dụng" }
  }
}
