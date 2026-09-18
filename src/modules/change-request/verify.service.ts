/**
 * C-5 kiểm đề xuất (nút 3.7–3.9, UC-82). FLF-171, plan §6 2E.
 * - Code (chặn): block vẫn do CR giữ khoá; `old_text` khớp block (lệch ⇒ `409 CR_OLD_TEXT_MISMATCH`); `edit` có
 *   đổi thật; `comment` có nội dung; `spine_ops` qua `planTransaction` chạy khô + bất biến; Spine giả lập không
 *   thêm cờ đỏ (hồ sơ luật mode 1).
 * - AI `CR_CONSISTENCY` (không chặn): nhận xét vàng trên phạm vi thay đổi.
 * Trượt ⇒ AI làm lại vị trí đó (`redo_count` ≤ 2) ⇒ vẫn trượt / vị trí sửa tay trượt ⇒ `manual_fix` (3.9).
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { FindingsOutput } from "../../shared/ai/response-parser.js"
import { textHash, normalizeText } from "../docx-ooxml/index.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { flagKey, runDeterministicCheck } from "../spine/deterministic-check.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"
import { ChangeLocation, type IChangeLocation, type VerifyViolation } from "./change-location.model.js"
import { crHeader, glossaryText, truncate } from "./cr-context.js"

type BlockLite = { block_id: string; text: string; text_hash: string; locked_by_cr: string | null; section_id: string | null; anchor: { ordinal: number } }

/** Kiểm tất định từng vị trí (không gồm op Spine). */
export const checkLocation = (cr: IChangeRequest, loc: IChangeLocation, block: BlockLite | undefined): VerifyViolation[] => {
  const out: VerifyViolation[] = []
  if (!loc.conclusion) return [{ rule: "unconcluded", message: "Vị trí chưa có kết luận" }]
  if (loc.conclusion === "not_related") return []
  if (!block) return [{ rule: "block_missing", message: `Block ${loc.block_id} không còn trong version hiện tại` }]
  if (block.locked_by_cr !== cr.cr_id) out.push({ rule: "block_not_locked", message: `Block ${loc.block_id} không do ${cr.cr_id} giữ khoá` })
  const p = loc.proposal
  if (!p) return [...out, { rule: "no_proposal", message: "Thiếu đề xuất" }]
  if (block.text_hash !== textHash(p.old_text)) {
    throw new Mode1Error("CR_OLD_TEXT_MISMATCH", `Text block ${loc.block_id} đã đổi so với lúc đề xuất`, { location_id: loc.location_id, block_id: loc.block_id })
  }
  if (loc.conclusion === "edit") {
    if (p.new_text === null || p.new_text === undefined) out.push({ rule: "edit_without_text", message: "Kết luận edit nhưng không có new_text" })
    else if (normalizeText(p.new_text) === normalizeText(p.old_text)) out.push({ rule: "edit_no_change", message: "new_text giống hệt text hiện tại" })
  }
  if (loc.conclusion === "comment" && !p.comment_text?.trim()) out.push({ rule: "comment_empty", message: "Kết luận comment nhưng không có nội dung" })
  return out
}

/** Chạy khô toàn bộ op Spine của CR; vi phạm gắn về vị trí sinh ra op. */
export const checkSpineOps = (spine: Spine, cr: IChangeRequest, locations: IChangeLocation[]): Map<string, VerifyViolation[]> => {
  const out = new Map<string, VerifyViolation[]>()
  const push = (locId: string, v: VerifyViolation) => out.set(locId, [...(out.get(locId) ?? []), v])
  const ops: Op[] = []
  const owner: string[] = []
  for (const l of locations) {
    if (l.conclusion !== "edit" && l.conclusion !== "comment") continue
    for (const raw of l.proposal?.spine_ops ?? []) {
      const parsed = userOpSchema.safeParse(raw)
      if (!parsed.success) {
        push(l.location_id, { rule: "op_invalid", message: "Op Spine sai định dạng" })
        continue
      }
      ops.push(parsed.data)
      owner.push(l.location_id)
    }
  }
  if (!ops.length) return out
  try {
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: cr.cr_id }, { startSeq: 1 })
    const before = new Set(runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red").map(flagKey))
    const newRed = runDeterministicCheck(plan.spine, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((c) => c.level === "red" && !before.has(flagKey(c)))
    for (const c of newRed) for (const locId of new Set(owner)) push(locId, { rule: "new_red_flag", message: `Op làm mở cờ đỏ ${c.rule_id}: ${c.message}` })
  } catch (err) {
    if (!(err instanceof TransactionRejectedError)) throw err
    for (const v of err.violations) {
      const locId = v.op_index !== undefined ? owner[v.op_index] : undefined
      for (const id of locId ? [locId] : [...new Set(owner)]) push(id, { rule: v.rule, message: v.message, ...(v.path ? { path: v.path } : {}) })
    }
  }
  return out
}

export const runVerify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["proposing", "manual_fix", "ready_to_submit", "verifying"], "verifying")
  await transitionCr(cr, "verifying")
  cr.paused = null
  await cr.save()
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)
  const version = (await latestDocVersion(cr.projectId))!
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  const blocks = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version })
    .select("block_id text text_hash locked_by_cr section_id anchor.ordinal")
    .sort({ "anchor.ordinal": 1 })
    .lean<BlockLite[]>()
  const blockOf = new Map(blocks.map((b) => [b.block_id, b]))

  const violations = new Map(locations.map((l) => [l.location_id, checkLocation(cr, l, blockOf.get(l.block_id))]))
  for (const [locId, vs] of checkSpineOps(spine, cr, locations)) violations.set(locId, [...(violations.get(locId) ?? []), ...vs])

  // AI consistency trên các vị trí có thay đổi và đã qua kiểm code
  const changed = locations.filter((l) => (l.conclusion === "edit" || l.conclusion === "comment") && !violations.get(l.location_id)?.length)
  const aiFlags = new Map<string, { rule: string; message: string }[]>()
  if (changed.length) {
    const neighbours = new Set<string>()
    for (const l of changed) {
      const idx = blocks.findIndex((b) => b.block_id === l.block_id)
      for (const j of [idx - 1, idx + 1]) if (blocks[j]) neighbours.add(blocks[j].block_id)
    }
    const result = await withMeteredAi<FindingsOutput>({ projectId: String(cr.projectId), userId, stepId: `C-5:${cr.cr_id}` }, ActionType.CR_CONSISTENCY, {
      ...crHeader(cr),
      edits: truncate(
        changed
          .map((l) => `[${l.location_id}][${l.block_id}] ${l.proposal?.old_text} → ${l.conclusion === "edit" ? l.proposal?.new_text : `(comment) ${l.proposal?.comment_text}`}`)
          .join("\n")
      ),
      scope: truncate([...neighbours].map((id) => `[${id}] (${blockOf.get(id)?.section_id ?? "-"}) ${blockOf.get(id)?.text}`).join("\n")),
      glossary: glossaryText(spine)
    })
    if (!result.ok) {
      cr.paused = { reason: result.reason, at: new Date() }
      await cr.save()
      return
    }
    for (const f of result.data.findings) {
      // Nhận xét trỏ block hàng xóm (không phải vị trí sửa) ⇒ gắn vào vị trí đầu tiên để người duyệt vẫn thấy
      const hit = changed.filter((c) => f.block_ids.includes(c.block_id))
      for (const l of hit.length ? hit : changed.slice(0, 1)) {
        aiFlags.set(l.location_id, [...(aiFlags.get(l.location_id) ?? []), { rule: f.rule, message: f.message }])
      }
    }
  }

  const at = new Date()
  const failing: IChangeLocation[] = []
  for (const l of locations) {
    const vs = violations.get(l.location_id) ?? []
    l.verify = { code_ok: vs.length === 0, violations: vs, ai_flags: aiFlags.get(l.location_id) ?? [], at }
    if (vs.length) failing.push(l)
  }
  let next: "ready_to_submit" | "proposing" | "manual_fix" = "ready_to_submit"
  if (failing.length) {
    next = failing.some((l) => l.manual || l.redo_count >= MAX_REDO_PER_LOCATION) ? "manual_fix" : "proposing"
    if (next === "proposing") for (const l of failing) l.redo_count += 1
  }
  await Promise.all(locations.map((l) => l.save()))
  await transitionCr(cr, next)
}
