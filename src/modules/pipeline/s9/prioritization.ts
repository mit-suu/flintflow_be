/**
 * prioritization.ts
 * ─────────────────────────────────────────────────────────────────
 * S-9.4 Requirement Prioritization (Phases §6.4, UC 6.6–6.7) — thay hẳn UC34/UC35 cũ
 * (`POST /specifications/:id/generate-priority` + `generate-scope`, audit B8).
 *
 * Khác bản cũ ở ba điểm:
 *   - MoSCoW ghi thẳng vào `functions[].priority` / `nfrs[].priority` bằng op, không phải một khối
 *     markdown rời; nhờ vậy §3/§4 render ra đã có cột Priority và truy vết được.
 *   - Chạy ở **cuối** quy trình (S-9), khi đã có đủ function và NFR — không phải ở phase 3 khi danh sách
 *     còn dang dở.
 *   - **Won't-have KHÔNG tự động chuyển `release_scope.out`** (audit §4 câu 13): đổi phạm vi là quyết
 *     định của người, không phải hệ quả của một lượt xếp hạng. Lệch thì chỉ cảnh báo.
 *
 * Model chỉ phát op; đi qua `draftOps` như mọi step Draft khác để dùng chung retry schema ≤ 2 và
 * `validateOps` (chỉ cho ghi `functions`, `nfrs`, `assumptions` theo step registry).
 */

import { applyTransaction } from "../../spine/op-engine.js"
import * as repository from "../../spine/spine.repository.js"
import type { Priority, Spine, SpineRecord } from "../../spine/spine.types.js"
import { buildStepContext } from "../context-projection.js"
import { draftOps, type DraftExecutor, type DraftUsage } from "../draft-to-ops.js"
import { ApiError } from "../../../shared/utils/api-error.js"

export const PRIORITIZATION_STEP = "S-9.4"
export const PRIORITIZATION_SKILL = "prioritization"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim()

export interface ScopeWarning {
  kind: "wont_not_in_scope_out" | "scope_out_not_wont"
  id: string
  name: string
  message: string
}

/**
 * Đối chiếu `priority = "wont"` với `project.release_scope.out` — **chỉ cảnh báo**, không sửa gì.
 * Hai chiều đều đáng nói: việc bị xếp Won't mà vẫn nằm trong phạm vi, và dòng out-of-scope mà không có
 * requirement nào Won't tương ứng.
 */
export const scopeWarnings = (spine: Spine): ScopeWarning[] => {
  const out = spine.project.release_scope.out.map(norm)
  const mentions = (name: string): boolean => out.some((line) => line.includes(norm(name)) || norm(name).includes(line))

  const warnings: ScopeWarning[] = []
  for (const fn of spine.functions) {
    if (fn.priority !== "wont" || mentions(fn.name)) continue
    warnings.push({
      kind: "wont_not_in_scope_out",
      id: fn.id,
      name: fn.name,
      message: `Function ${fn.id} "${fn.name}" được xếp Won't-have nhưng không có dòng nào trong release_scope.out nhắc tới — phạm vi không tự đổi theo MoSCoW, cần bạn quyết.`
    })
  }
  for (const nfr of spine.nfrs) {
    if (nfr.priority !== "wont" || mentions(nfr.statement)) continue
    warnings.push({
      kind: "wont_not_in_scope_out",
      id: nfr.id,
      name: nfr.statement,
      message: `NFR ${nfr.id} được xếp Won't-have nhưng không có dòng nào trong release_scope.out nhắc tới.`
    })
  }
  return warnings
}

/** Requirement chưa được xếp hạng sau lượt chạy — S-9.4 phải phủ hết. */
export const unprioritized = (spine: Spine): { functions: string[]; nfrs: string[] } => ({
  functions: spine.functions.filter((f) => f.priority === null).map((f) => f.id),
  nfrs: spine.nfrs.filter((n) => n.priority === null).map((n) => n.id)
})

export const PRIORITIES: readonly Priority[] = Object.freeze(["must", "should", "could", "wont"])

export interface PrioritizeOptions {
  /** Mock provider trong test; mặc định `draftOps` gọi model thật. */
  executor?: DraftExecutor
  sessionId?: string | null
}

export interface PrioritizeResult {
  spine_version: number
  /** Số requirement đã có `priority` sau lượt chạy. */
  prioritized: { functions: number; nfrs: number }
  unprioritized: { functions: string[]; nfrs: string[] }
  warnings: ScopeWarning[]
  notes: string | null
  /** Lượt gọi model đã dùng — bên gọi (`run-s9-step`) ghi vào `usage[]` qua meter. */
  usage: DraftUsage[]
}

/**
 * Chạy S-9.4. Trả về cảnh báo phạm vi để runner/UI hiển thị — KHÔNG tự sửa `release_scope`.
 * `ctx.skill` được đặt tay vì `STEP_SKILLS` (vùng của T11/T14) không ánh xạ step S-9.
 */
export const prioritize = async (projectId: string, userId: string, options: PrioritizeOptions = {}): Promise<PrioritizeResult> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)

  const base = await buildStepContext(projectId, PRIORITIZATION_STEP, { sessionId: options.sessionId ?? null })
  const ctx = { ...base, skill: PRIORITIZATION_SKILL }
  const spine = stripRecord(record)

  const draft = await draftOps(projectId, PRIORITIZATION_STEP, ctx, {
    userId,
    spine,
    ...(options.executor ? { executor: options.executor } : {})
  })

  let spineVersion = record.spine_version
  if (draft.txn) {
    const applied = await applyTransaction(projectId, draft.txn)
    spineVersion = applied.spine_version
  }

  const after = await repository.get(projectId)
  const finalSpine = after ? stripRecord(after) : spine

  return {
    spine_version: spineVersion,
    prioritized: {
      functions: finalSpine.functions.filter((f) => f.priority !== null).length,
      nfrs: finalSpine.nfrs.filter((n) => n.priority !== null).length
    },
    unprioritized: unprioritized(finalSpine),
    warnings: scopeWarnings(finalSpine),
    notes: draft.notes,
    usage: draft.usage
  }
}
