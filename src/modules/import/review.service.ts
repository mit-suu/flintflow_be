/**
 * review.service.ts — FLF-453, business-flow §3.1.2 "Rà soát phần có sẵn" (bước 1.11, 1.12 cũ của chế độ 3/4; không
 * nhầm với 1.11/1.12 của chế độ 1 trong `check.service.ts`). Vòng rà soát chạy TRƯỚC Luồng 2 khi file còn thiếu mục
 * (chế độ 3/4):
 * - I-5 đã chạy luật Code (Tầng 1, 2, 3 theo luật, `flags.service.ts`) trên mọi mục có sẵn ngay trong `finalize.service.ts`,
 *   không tốn credit.
 * - AI chỉ rà các mục **là đầu vào của phần thiếu** (bảng §4 owner/reads của `section-registry.ts` — cùng dữ liệu C-3
 *   Impact dùng) và mục đang mang **cờ đỏ** do Code bắt.
 * - Không mục nào cần rà (vd file chỉ có heading) ⇒ bỏ qua vòng rà soát, sang thẳng Luồng 2 (hành vi trước FLF-453,
 *   `enterFlow2` gọi ngay — không đổi).
 * Rà xong ⇒ Luồng 2 từ 2.4 (`enterFlow2`).
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { applyTransaction } from "../spine/op-engine.js"
import { FIELD_SECTION_MAP } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { Usage } from "../spine/usage.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { DocBlock } from "./doc-block.model.js"
import { type CheckBlock, findingOps, parallelBatches, runLimited, semanticBatches, semanticProjection, stripRecord } from "./check.service.js"
import { enterFlow2, type Flow2Result } from "./flow2.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi } from "./metered-ai.js"
import type { TargetStructure } from "./target-structure.js"

/** Cờ của vòng rà soát (business-flow §3.1.2) — vàng, người dùng Chấp nhận / Giữ nguyên + lý do (`flags.service.ts`). */
export const REVIEW_RULE = "import_review"
/** Tiền tố step — tách khỏi `I-1.11` (1.11 thật, chế độ 1) để hai vòng không tranh id Usage khi cùng tồn tại trên dữ liệu cũ. */
export const REVIEW_STEP = "I-1.11r"
const reviewBatchStep = (n: number): string => `${REVIEW_STEP}:${n}`

/** `owner` của bảng §4 khớp một section_id thật: literal (`fixed:1`) hoặc khuôn `feature:<id>` / `function:<id>`. */
const ownerMatchesSection = (owner: string, sectionId: string): boolean => {
  if (owner === sectionId) return true
  const m = /^(feature|function):<.*>$/.exec(owner)
  return !!m && sectionId.startsWith(`${m[1]}:`)
}

/**
 * Mục có sẵn là đầu vào của ít nhất một mục còn thiếu — tra bảng §4 `owner`/`reads` của `section-registry.ts` (cùng dữ
 * liệu C-3 Impact dùng): `reads` của một hàng là các mục bị ảnh hưởng khi `owner` đổi, nên `owner` chính là "đầu vào"
 * của mục trong `reads`. Product Overview (`fixed:1`) luôn là đầu vào của Brief: sang Luồng 2, B-1…S-1 luôn mở lại để
 * phân tích phần đã có (`flow2.service.ts` `FLOW2_BRIEF_PHASES`), bất kể owner/reads của bảng §4.
 */
export const reviewInputSections = (structure: Pick<TargetStructure, "sections" | "missing">): string[] => {
  if (!structure.missing.length) return []
  const missingIds = new Set(structure.missing)
  const present = structure.sections.filter((s) => s.status === "present").map((s) => s.section_id)
  const inputs = new Set<string>()
  for (const row of FIELD_SECTION_MAP) {
    if (!row.reads.some((r) => missingIds.has(r))) continue
    for (const owner of row.owner) for (const id of present) if (ownerMatchesSection(owner, id)) inputs.add(id)
  }
  if (present.includes("fixed:1")) inputs.add("fixed:1")
  return [...inputs]
}

/** Mục có sẵn đang mang cờ đỏ chưa gỡ (Code bắt ở I-5 — `flags.service.ts` `recompute`, business-flow §3.1.2). */
export const redFlaggedPresentSections = (structure: Pick<TargetStructure, "sections">, flags: readonly Flag[]): string[] => {
  const present = new Set(structure.sections.filter((s) => s.status === "present").map((s) => s.section_id))
  return [...new Set(flags.filter((f) => f.level === "red" && f.resolved_at === null && present.has(f.section_id)).map((f) => f.section_id))]
}

/**
 * Mục Code chọn cho AI rà trước Luồng 2 (business-flow §3.1.2) — hợp của hai nhóm trên. Rỗng ⇒ bỏ qua vòng rà soát.
 */
export const sectionsNeedingAiReview = (structure: Pick<TargetStructure, "sections" | "missing">, flags: readonly Flag[]): string[] => [
  ...new Set([...reviewInputSections(structure), ...redFlaggedPresentSections(structure, flags)])
]

const reviewBlocks = async (projectId: string, sectionIds: readonly string[]): Promise<CheckBlock[]> =>
  DocBlock.find({
    projectId,
    doc_version: { $in: IMPORTED_DOC_VERSIONS },
    kind: { $in: ["paragraph", "list_item", "table_cell"] },
    section_id: { $in: [...sectionIds] }
  })
    .sort({ "anchor.ordinal": 1 })
    .select("block_id text section_id mentions")
    .lean<CheckBlock[]>()

/** Ước tính credit vòng rà soát (báo trước khi chạy, business-flow §2 "Báo trước khi chạy hàng loạt"). */
export const estimateReviewCredit = async (projectId: string, sectionIds: readonly string[]): Promise<{ batches: number; calls: number; credits: number }> => {
  if (!sectionIds.length) return { batches: 0, calls: 0, credits: 0 }
  const blocks = await reviewBlocks(projectId, sectionIds)
  const batches = semanticBatches(blocks).length
  if (!batches) return { batches: 0, calls: 0, credits: 0 }
  const cost = await getActionCost(ActionType.IMPORT_REVIEW_EXISTING)
  return { batches, calls: batches, credits: batches * cost }
}

const loadSpine = async (projectId: string): Promise<Spine> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  return stripRecord(record)
}

const applyReviewFindings = async (projectId: string, findings: FindingsOutput["findings"], reason: string): Promise<void> => {
  if (!findings.length) return
  const spine = await loadSpine(projectId)
  const ops = findingOps(spine, findings, REVIEW_RULE)
  if (ops.length) await applyTransaction(projectId, { base_version: spine.spine_version, ops, by: "import", reason, step_id: null })
}

type ReviewGuard = () => Promise<void>
const noGuard: ReviewGuard = async () => undefined

/**
 * Chạy vòng rà soát (business-flow §3.1.2) rồi vào Luồng 2. `sectionIds` rỗng ⇒ không gọi AI, vào Luồng 2 ngay (nhánh
 * "không mục nào cần rà"). Lượt AI lỗi / hết credit ⇒ `doc.paused` được đặt, trả `{ paused: true }`, giữ tiến độ — lượt
 * đã trừ credit (`Usage` `deducted`) không gọi lại khi resume (gọi lại chính hàm này).
 */
export const runReview = async (
  doc: IImportedDocument,
  userId: string,
  sectionIds: readonly string[],
  guard: ReviewGuard = noGuard
): Promise<{ paused: true } | Flow2Result> => {
  const projectId = String(doc.projectId)
  if (sectionIds.length) {
    const done = new Set<string>(await Usage.find({ projectId, step_id: { $regex: /^I-1\.11r(:|$)/ }, state: "deducted" }).distinct("step_id"))
    const blocks = await reviewBlocks(projectId, sectionIds)
    const spine = await loadSpine(projectId)
    const batches = semanticBatches(blocks)
      .map((b, i) => ({ ...b, step_id: reviewBatchStep(i + 1) }))
      .filter((b) => !done.has(b.step_id))
    const results = await runLimited(batches, parallelBatches(), async (batch) => {
      await guard()
      return withMeteredAi<FindingsOutput>({ projectId, userId, stepId: batch.step_id }, ActionType.IMPORT_REVIEW_EXISTING, {
        section_ids: batch.section_ids.join(", "),
        projection: semanticProjection(spine),
        blocks: batch.lines
      })
    })
    for (const r of results) {
      if (!r) continue
      if (!r.ok) {
        doc.paused = { reason: r.reason, at: new Date() }
        await doc.save()
        return { paused: true }
      }
      await applyReviewFindings(projectId, r.data.findings, "AI rà soát phần có sẵn (business-flow §3.1.2)")
    }
  }
  doc.paused = null
  await doc.save()
  return enterFlow2(doc, userId)
}
