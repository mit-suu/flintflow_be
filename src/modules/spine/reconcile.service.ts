/**
 * reconcile.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Hoà giải **một lượt, thủ công** (UC 6.10, Phases §9.1): user bấm "Hoà giải" một lần cho tất cả section
 * đang `stale`, xem một diff gộp, rồi quyết áp hay không. KHÔNG tự lan toả — đó là điều srs-spine §9
 * cấm; stale chỉ được gỡ khi user đồng ý.
 *
 * Một lượt gồm:
 *   1. Liệt kê section `stale` (hàm tính của T09, không lưu DB).
 *   2. Mỗi section gọi skill của **step sở hữu** nó, với projection đúng field step đó đọc + đúng các
 *      change đã làm nó stale (không nạp cả Spine, không nạp change không liên quan).
 *   3. Gom ops, trả preview diff gộp (`preview_id`).
 *   4. User xác nhận ⇒ áp một transaction, vẽ lại diagram có `source_hash` lệch, đặt section về
 *      `awaiting_reaccept` (step sở hữu → `revision_requested`, gate Accept của T13 xoá cờ này).
 *
 * User từ chối diff ⇒ không gọi lại gì, section vẫn `stale`. Đó là trạng thái hợp lệ.
 *
 * FLF-177 BUG-16: khi model **không đề xuất thay đổi nào** (nội dung vẫn đúng, chỉ là dữ liệu nguồn đã
 * đổi ở chỗ khác), lượt hoà giải cũ trả "Không có thay đổi nào" với nút Xác nhận bị khoá — cờ đỏ
 * `section_stale_at_baseline` ở lại vĩnh viễn và user phải waive. Nay lượt đó vẫn có `preview_id`: user
 * bấm **"Xác nhận không đổi"** để chấp nhận lại section nguyên trạng (step sở hữu được đánh dấu accepted
 * tới seq hiện tại), cờ tự đóng ở lượt quét kế tiếp.
 */

import { randomUUID } from "node:crypto"
import { renderDiagrams, staleDiagrams } from "../diagram/diagram.service.js"
import type { RenderTarget } from "../diagram/renderers/index.js"
import { projectStep } from "../pipeline/context-projection.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { applyTransaction } from "./op-engine.js"
import * as repository from "./spine.repository.js"
import { computeSectionStates } from "./section-status.js"
import { sectionsOfPath, stepsOf } from "./section-registry.js"
import {
  apply as applyChange,
  defaultChangeDeps,
  preview as previewChange,
  type ChangeApplyResult,
  type ChangeDeps,
  type ChangePreviewResult
} from "./change.service.js"
import type { Op } from "./op.types.js"
import type { Change, Spine, SpineRecord } from "./spine.types.js"

/** Trần số section hoà giải trong một lượt — mỗi section là một lượt gọi model. */
export const MAX_RECONCILE_SECTIONS = 12

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

export type ReconcileExecutor = (
  actionType: ActionType,
  input: AiActionInput,
  projectId: string,
  userId: string
) => Promise<AiActionResult<OpTransaction>>

export interface ReconcileDeps extends ChangeDeps {
  reconcileExecutor: ReconcileExecutor
  /** Vẽ lại diagram sau khi áp; test cắm hàm giả để không gọi PlantUML. */
  rerender: (projectId: string, targets: RenderTarget[], userId: string) => Promise<unknown>
}

/**
 * Đủ mọi dep (kể cả `recomputeFlags` của ChangeDeps): nhánh "xác nhận không đổi" gọi thẳng `recomputeFlags`,
 * không đi qua `change.service` — thiếu dep ở đây là lỗi runtime `deps.recomputeFlags is not a function`.
 */
export const defaultReconcileDeps = (): ReconcileDeps => ({
  ...defaultChangeDeps(),
  reconcileExecutor: (actionType, input, projectId, userId) => executeAiAction<OpTransaction>(actionType, input, projectId, userId),
  rerender: (projectId, targets, userId) => renderDiagrams(projectId, targets, { by: userId, step_id: null })
})

// ─── section stale và change gây ra nó ───────────────────────────

/**
 * Change đã làm `sectionId` stale: nuôi section đó (3 cột bảng §4) và có `seq` lớn hơn mốc accept của
 * step sở hữu. Cùng định nghĩa với `section-status.ts` — không có luật thứ hai.
 */
export const changesMakingStale = (spine: Spine, changes: readonly Change[], sectionId: string): Change[] => {
  const own = new Set(stepsOf(sectionId, spine))
  const steps = new Map(spine.steps.map((s) => [s.id, s]))
  const accepted = [...own].map((id) => steps.get(id)).filter((s) => s?.status === "accepted")
  if (accepted.length === 0) return []
  const threshold = Math.max(...accepted.map((s) => s?.last_seq ?? 0))

  return changes.filter((change) => {
    if (change.seq <= threshold) return false
    if (change.step_id !== null && own.has(change.step_id)) return false
    const impact = sectionsOfPath(spine, change.path, change)
    return [...impact.owner, ...impact.reads, ...impact.derived].includes(sectionId)
  })
}

export interface StaleSectionBrief {
  section_id: string
  owner_step: string
  changes: { path: string; before: unknown; value: unknown; reason: string | null }[]
}

/** Section `stale` kèm step sở hữu và các change gây ra — đầu vào của một lượt hoà giải. */
export const staleSections = (spine: Spine, changes: readonly Change[]): StaleSectionBrief[] =>
  computeSectionStates(spine, changes as Change[])
    .filter((s) => s.status === "stale")
    .slice(0, MAX_RECONCILE_SECTIONS)
    .map((section) => ({
      section_id: section.id,
      owner_step: stepsOf(section.id, spine)[0] ?? "",
      changes: changesMakingStale(spine, changes, section.id).map(({ path, before, value, reason }) => ({ path, before, value, reason }))
    }))
    .filter((brief) => brief.owner_step !== "")

// ─── lô ops đề xuất ──────────────────────────────────────────────

/** `preview_id` → section đã gộp vào lô, để sau khi áp đặt đúng những section đó `awaiting_reaccept`. */
const reconciledSections = new Map<string, string[]>()

/** `preview_id` của lượt "không có gì cần đổi" → section user sắp xác nhận nguyên trạng (BUG-16). */
const noChangePreviews = new Map<string, string[]>()

export const clearReconcileState = (): void => {
  reconciledSections.clear()
  noChangePreviews.clear()
}

/**
 * Gọi skill của step sở hữu cho từng section stale, gom ops lại. Step tất định/render (skill null)
 * không gọi model — diagram của nó được vẽ lại bằng code sau khi áp.
 */
const proposeOps = async (
  projectId: string,
  userId: string,
  spine: Spine,
  briefs: readonly StaleSectionBrief[],
  deps: ReconcileDeps
): Promise<{ ops: Op[]; sections: string[] }> => {
  const ops: Op[] = []
  const sections: string[] = []

  for (const brief of briefs) {
    let projection: ReturnType<typeof projectStep>
    try {
      projection = projectStep(spine, brief.owner_step)
    } catch {
      // Step không có trong registry (section của feature/function chưa tới vòng) — bỏ qua, vẫn stale
      continue
    }
    sections.push(brief.section_id)
    if (projection.skill === null) continue

    const result = await deps.reconcileExecutor(
      ActionType.RECONCILE,
      {
        promptVariables: {
          call_kind: "reconcile",
          user_message: "(reconcile)",
          is_pipeline: false,
          has_baseline: spine.baselines.length > 0,
          step_id: brief.owner_step,
          step_name: projection.label_en,
          writable_paths: projection.writable.join(", "),
          projection: projection.projection,
          glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
          stale_sections: [brief]
        }
      },
      projectId,
      userId
    )
    ops.push(...((result.data.ops ?? []) as Op[]))
  }

  return { ops, sections }
}

// ─── điểm vào ────────────────────────────────────────────────────

export interface ReconcileBody {
  base_version: number
  preview_id?: string
}

export type ReconcileResult = ChangePreviewResult | ChangeApplyResult

export const isReconcileApplied = (result: ReconcileResult): result is ChangeApplyResult => "spine_version" in result

/**
 * Lượt 1 (không `preview_id`): trả preview diff gộp.
 * Lượt 2 (có `preview_id`): áp, vẽ lại diagram lệch hash, đặt `awaiting_reaccept`.
 */
export const reconcile = async (
  projectId: string,
  userId: string,
  body: ReconcileBody,
  init: repository.SpineInit = {},
  deps: Partial<ReconcileDeps> = {}
): Promise<ReconcileResult> => {
  const d: ReconcileDeps = { ...defaultReconcileDeps(), ...deps }

  if (body.preview_id !== undefined && noChangePreviews.has(body.preview_id)) {
    const sections = noChangePreviews.get(body.preview_id) ?? []
    noChangePreviews.delete(body.preview_id)
    return await confirmNoChange(projectId, userId, body.base_version, sections, d)
  }

  if (body.preview_id !== undefined) {
    const sections = reconciledSections.get(body.preview_id) ?? []
    reconciledSections.delete(body.preview_id)
    const applied = await applyChange(projectId, userId, { base_version: body.base_version, preview_id: body.preview_id }, init, d)
    const afterRender = await rerenderStale(projectId, userId, applied.spine, d)
    const version = await markAwaitingReaccept(projectId, userId, afterRender, sections)
    const record = await repository.get(projectId)
    return { ...applied, ...(record ? { spine: record, spine_version: record.spine_version } : { spine_version: version }) }
  }

  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== body.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }

  const spine = stripRecord(record)
  const changes = await repository.listChanges(projectId)
  const briefs = staleSections(spine, changes)
  const proposed = await proposeOps(projectId, userId, spine, briefs, d)

  if (proposed.ops.length === 0) {
    // BUG-16: còn section stale mà không có gì cần sửa ⇒ vẫn cấp `preview_id` để user xác nhận nguyên trạng
    const previewId = randomUUID()
    if (briefs.length > 0) noChangePreviews.set(previewId, proposed.sections.length > 0 ? proposed.sections : briefs.map((b) => b.section_id))
    return {
      ok: true,
      txn: `reconcile-${body.base_version}`,
      base_version: body.base_version,
      ops: [],
      changes: [],
      violations: [],
      referrers: [],
      branch: "silent",
      ...(briefs.length > 0 ? { preview_id: previewId, no_change: true } : {}),
      notes:
        briefs.length === 0
          ? "Không có section nào đang stale."
          : `${briefs.length} section vẫn đúng nội dung — xác nhận không đổi để gỡ cờ, hoặc sửa tay qua chat.`
    }
  }

  const preview = await previewChange(projectId, userId, { base_version: body.base_version, ops: proposed.ops, reason: "Hoà giải section stale" }, init, d)
  if (preview.preview_id !== undefined) reconciledSections.set(preview.preview_id, proposed.sections)
  return preview
}

/**
 * "Xác nhận không đổi" (BUG-16): user đọc các thay đổi ở nơi khác và thấy section vẫn đúng ⇒ chấp nhận lại
 * nguyên trạng. Step sở hữu được đánh dấu accepted tới seq hiện tại, nên `stale` (hàm tính từ seq) tắt và
 * cờ `section_stale_at_baseline` đóng ở lượt quét kế tiếp. Không ghi nội dung nào — đây là một quyết định
 * của người, và nó được ghi lại như mọi quyết định khác trong `changes[]`.
 */
const confirmNoChange = async (
  projectId: string,
  userId: string,
  baseVersion: number,
  sectionIds: readonly string[],
  deps: ReconcileDeps
): Promise<ChangeApplyResult> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
  const spine = stripRecord(record)
  const latestSeq = (await repository.nextSeq(projectId)) - 1
  const at = new Date().toISOString()

  const ops: Op[] = []
  const seen = new Set<string>()
  for (const sectionId of sectionIds) {
    for (const stepId of stepsOf(sectionId, spine)) {
      const step = spine.steps.find((s) => s.id === stepId)
      if (!step || step.status !== "accepted" || seen.has(stepId)) continue
      seen.add(stepId)
      if (step.last_seq !== latestSeq) ops.push({ op: "set", path: `steps[id=${stepId}].last_seq`, value: latestSeq })
      ops.push({ op: "set", path: `steps[id=${stepId}].accepted_at`, value: at })
    }
  }

  const applied =
    ops.length > 0
      ? await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, step_id: null, reason: "Hoà giải: user xác nhận nội dung không đổi" })
      : { spine: record, changes: [], txn: null, spine_version: record.spine_version }

  await rerenderStale(projectId, userId, applied.spine, deps)
  await deps.recomputeFlags(projectId, userId)
  const after = await repository.get(projectId)

  return {
    spine: after ?? applied.spine,
    changes: applied.changes,
    txn: applied.txn,
    spine_version: after?.spine_version ?? applied.spine_version,
    branch: "silent",
    impact: { fields: [], sections: sectionIds.map((id) => ({ id, relation: "owner" as const })), diagrams: [], referrers: [] }
  }
}

/** Vẽ lại đúng những hình `source_hash` lệch sau khi áp lô hoà giải. */
const rerenderStale = async (projectId: string, userId: string, spine: SpineRecord, deps: ReconcileDeps): Promise<number> => {
  const targets = staleDiagrams(stripRecord(spine)).map((d) => ({ kind: d.kind, owner_id: d.owner_id }))
  if (targets.length === 0) return spine.spine_version
  await deps.rerender(projectId, targets, userId)
  return (await repository.get(projectId))?.spine_version ?? spine.spine_version
}

/**
 * Section vừa hoà giải chờ user chấp nhận lại: đặt step sở hữu về `revision_requested`
 * (`section-status.awaitingReaccept` đọc đúng cờ này). Step chưa từng accepted thì để nguyên.
 */
const markAwaitingReaccept = async (projectId: string, userId: string, baseVersion: number, sectionIds: readonly string[]): Promise<number> => {
  if (sectionIds.length === 0) return baseVersion
  const record = await repository.get(projectId)
  if (!record) return baseVersion
  const spine = stripRecord(record)

  const stepIds = new Set<string>()
  for (const sectionId of sectionIds) {
    for (const stepId of stepsOf(sectionId, spine)) {
      if (spine.steps.find((s) => s.id === stepId)?.status === "accepted") stepIds.add(stepId)
    }
  }
  if (stepIds.size === 0) return record.spine_version

  const ops: Op[] = [...stepIds].map((id) => ({ op: "set", path: `steps[id=${id}].status`, value: "revision_requested" }))
  const applied = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops,
    by: userId,
    step_id: null,
    reason: "Hoà giải: chờ chấp nhận lại"
  })
  return applied.spine_version
}
