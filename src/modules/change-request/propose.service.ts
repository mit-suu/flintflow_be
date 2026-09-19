/**
 * C-4 đề xuất cho từng vị trí (nút 3.6, UC-81): `edit` | `comment` | `not_related` + lý do. FLF-171, plan §6 2E.
 * Theo lô vị trí cùng owner step (≤ 12 vị trí/lượt, mỗi lượt giữ credit riêng); prompt = skill `cr-propose` +
 * quy tắc viết của skill nội dung của owner step (`STEP_SKILLS`) + text block + CR. Vị trí sửa tay (`manual`)
 * không bị AI đè; lần làm lại (sau verify trượt) chỉ đề xuất lại vị trí trượt. Gom change group theo section.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { CrProposeOutput } from "../../shared/ai/response-parser.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { STEP_SKILLS, parseStepId } from "../pipeline/context-projection.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { regroup } from "./group.service.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import { answersText, crHeader, glossaryText, truncate } from "./cr-context.js"

export const PROPOSE_BATCH = 12

const ownerSkillText = (ownerStep: string | null): string => {
  if (!ownerStep) return "(none — prose not tied to a structured field)"
  const skillId = STEP_SKILLS[parseStepId(ownerStep).base]
  if (!skillId) return "(none)"
  try {
    return truncate(getSkill(skillId).template, 4000)
  } catch {
    return "(none)"
  }
}

const needsProposal = (l: IChangeLocation): boolean => !l.manual && (l.conclusion === null || (l.verify !== null && !l.verify.code_ok))

/** Số lượt gọi AI tối đa cho một lô: lượt đầu + một lượt chỉ cho vị trí model bỏ sót. */
export const PROPOSE_ATTEMPTS = 2

type ProposalOut = CrProposeOutput["locations"][number]

/**
 * Ghép output C-4 với vị trí của lô. Chạy thật (e2e P3) thấy model đôi khi đánh số lại `location_id` theo thứ tự
 * trong lô (trả `L001`, `L002` cho lô `L005`, `L006`) ⇒ khớp theo `location_id`, rồi `block_id`; phần output còn
 * lại khớp theo thứ tự **chỉ khi** số lượng bằng đúng số vị trí còn thiếu (không đoán khi lệch).
 */
export const matchProposals = <L extends { location_id: string; block_id: string }>(batch: readonly L[], outputs: readonly ProposalOut[]): Map<L, ProposalOut> => {
  const matched = new Map<L, ProposalOut>()
  const leftover: ProposalOut[] = []
  for (const out of outputs) {
    const loc = batch.find((l) => !matched.has(l) && (l.location_id === out.location_id || l.block_id === out.location_id))
    if (loc) matched.set(loc, out)
    else leftover.push(out)
  }
  const missing = batch.filter((l) => !matched.has(l))
  if (leftover.length > 0 && leftover.length === missing.length) missing.forEach((l, i) => matched.set(l, leftover[i]))
  return matched
}

export const runPropose = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["impact_review", "proposing"], "proposing")
  await transitionCr(cr, "proposing")
  cr.paused = null
  await cr.save()
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)
  const version = (await latestDocVersion(cr.projectId))!
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  const blocks = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version, block_id: { $in: locations.map((l) => l.block_id) } }).lean()
  const blockOf = new Map(blocks.map((b) => [b.block_id, b]))

  const todo = locations.filter(needsProposal)
  const byOwner = new Map<string, IChangeLocation[]>()
  for (const l of todo) byOwner.set(l.owner_step ?? "", [...(byOwner.get(l.owner_step ?? "") ?? []), l])
  for (const [owner, group] of byOwner) {
    for (let i = 0; i < group.length; i += PROPOSE_BATCH) {
      // Model bỏ sót vị trí ⇒ gọi lại một lần cho riêng phần thiếu; vẫn thiếu thì để `conclusion = null` (sửa tay)
      let batch = group.slice(i, i + PROPOSE_BATCH)
      for (let attempt = 0; attempt < PROPOSE_ATTEMPTS && batch.length > 0; attempt++) {
        const locationsText = batch
          .map((l) => {
            const b = blockOf.get(l.block_id)
            const why = `found by ${l.found_by.join(", ")}${l.entity_paths.length ? `; about ${l.entity_paths.join(", ")}` : ""}`
            const failed = l.verify && !l.verify.code_ok ? `\n  Previous proposal failed checks: ${l.verify.violations.map((v) => v.message).join("; ")}` : ""
            return `[${l.location_id}][${l.block_id}] (${b?.heading_path.join(" > ") ?? ""}; ${why})\n  ${b?.text ?? ""}${failed}`
          })
          .join("\n")
        const result = await withMeteredAi<CrProposeOutput>({ projectId: String(cr.projectId), userId, stepId: `C-4:${cr.cr_id}` }, ActionType.CR_PROPOSE, {
          ...crHeader(cr),
          answers: answersText(cr),
          owner_skill: ownerSkillText(owner || null),
          locations: locationsText,
          glossary: glossaryText(spine)
        })
        if (!result.ok) {
          cr.paused = { reason: result.reason, at: new Date() }
          await cr.save()
          return
        }
        const matched = matchProposals(batch, result.data.locations)
        for (const [loc, out] of matched) {
          loc.conclusion = out.conclusion
          loc.reason = out.reason
          loc.proposal = {
            old_text: blockOf.get(loc.block_id)?.text ?? "",
            new_text: out.conclusion === "edit" ? (out.new_text ?? "") : null,
            comment_text: out.conclusion === "comment" ? (out.comment_text ?? null) : null,
            spine_ops: out.conclusion === "not_related" ? [] : out.spine_ops
          }
          loc.verify = null
          await loc.save()
        }
        batch = batch.filter((l) => !matched.has(l))
      }
      if (batch.length) console.warn(`[C-4] ${cr.cr_id}: model bỏ sót ${batch.map((l) => l.location_id).join(", ")} sau ${PROPOSE_ATTEMPTS} lượt — chờ sửa tay`)
    }
  }
  await regroup(cr)
}
