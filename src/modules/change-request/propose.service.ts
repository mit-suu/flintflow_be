/**
 * C-4 đề xuất cho từng vị trí (nút 3.6, UC-81): `edit` | `comment` | `not_related` + lý do. FLF-171, plan §6 2E.
 * Theo lô vị trí cùng owner step (≤ 12 vị trí/lượt, mỗi lượt giữ credit riêng); prompt = skill `cr-propose` +
 * quy tắc viết của skill nội dung của owner step (`STEP_SKILLS`) + giá trị phần tử + CR. Vị trí sửa tay (`manual`)
 * không bị AI đè; lần làm lại (sau verify trượt) chỉ đề xuất lại vị trí trượt. Gom change group theo section.
 * Mode 1 v2 (FLF-186): vị trí là phần tử Spine, `edit` = op Spine; BE chụp giá trị trước (`old_text`) và sau khi chạy
 * khô op của vị trí (`new_text`) để người duyệt đọc — tài liệu được render lại từ Spine khi ghi (C-7).
 * Mode 1 v3 phase 7: prompt kèm tài liệu bổ sung + dữ kiện C-2 báo thiếu; dữ kiện model phải tự giả định ghi vào
 * `proposal.assumptions` để người duyệt xác nhận ở 3.12.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { locksOf, pathLocked } from "./lock.service.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { CrProposeOutput } from "../../shared/ai/response-parser.js"
import { stripRecord } from "../import/check.service.js"
import { titleOfSection } from "../import/gap-report.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { STEP_SKILLS, parseStepId } from "../pipeline/context-projection.js"
import { planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { regroup } from "./group.service.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import { answersText, crHeader, glossaryText, materialsText, missingInfoText, truncate } from "./cr-context.js"
import { elementValue, isArrayPath, isSectionTarget, opElement, valueText } from "./spine-location.js"

/**
 * Số vị trí gửi trong một lượt C-4. Trước là 12: prompt kèm giá trị JSON của từng phần tử (tới 2500 ký tự) và câu
 * trả lời phải có đề xuất + op cho mọi vị trí ⇒ GLM suy nghĩ hết sạch `max_tokens` trước khi kịp trả `content`
 * (`GLM_EMPTY_OUTPUT`, 2026-09-20). Lô nhỏ giữ cả prompt lẫn câu trả lời trong ngân sách; lô nào vẫn lỗi thì
 * `runPropose` tự chia đôi.
 */
export const PROPOSE_BATCH = 4

const ownerSkillText = (ownerStep: string | null): string => {
  if (!ownerStep) return "(none — free-form section kept verbatim from the uploaded file)"
  const skillId = STEP_SKILLS[parseStepId(ownerStep).base]
  if (!skillId) return "(none)"
  try {
    return truncate(getSkill(skillId).template, 4000)
  } catch {
    return "(none)"
  }
}

/** Giá trị phần tử `path` sau khi chạy khô `rawOps` trên Spine hiện tại — op sai ⇒ `null` (C-5 báo lỗi cụ thể). */
export const previewAfter = (spine: Spine, path: string, rawOps: readonly unknown[]): string | null => {
  const ops: Op[] = []
  for (const raw of rawOps) {
    const parsed = userOpSchema.safeParse(raw)
    if (!parsed.success) return null
    ops.push(parsed.data)
  }
  if (!ops.length) return valueText(elementValue(spine, path))
  try {
    return valueText(elementValue(planTransaction(spine, { base_version: spine.spine_version, ops, by: "preview" }, { startSeq: 1 }).spine, path))
  } catch {
    return null
  }
}

type PromptLocation = Pick<IChangeLocation, "location_id" | "path" | "section_id" | "found_by" | "entity_paths" | "verify">

/** Op của bản xem trước đính kèm CR chạm vào vị trí này (phần tử, hoặc thêm vào đúng mảng của vị trí "mục trống"). */
export const seedOpsFor = (seedOps: readonly Record<string, unknown>[], path: string): Record<string, unknown>[] =>
  seedOps.filter((op) => {
    const p = typeof op.path === "string" ? op.path : ""
    return isArrayPath(path) ? p === path : opElement(p) === path
  })

/** Mô tả vị trí trong prompt C-4: `[L001] path (section; tìm thấy vì…)` rồi giá trị hiện tại (JSON, thụt lề). */
export const locationPromptText = (spine: Spine, l: PromptLocation, seedOps: readonly Record<string, unknown>[] = []): string => {
  const why = `found by ${l.found_by.join(", ")}${l.entity_paths.length ? `; about ${l.entity_paths.join(", ")}` : ""}`
  const failed = l.verify && !l.verify.code_ok ? `\n  Previous proposal failed checks: ${l.verify.violations.map((v) => v.message).join("; ")}` : ""
  const section = l.section_id === "misc" ? "-" : titleOfSection(spine, l.section_id)
  const value = truncate(valueText(elementValue(spine, l.path)), 2500).split("\n").join("\n  ")
  // Ô thêm mới: path là cả mảng ⇒ việc hợp lệ duy nhất là thêm phần tử mới. Mục trống (phương án B) hoặc mục đã có
  // dữ liệu mà CR cần phần tử chưa có (2026-09-24) — phần tử có sẵn là các vị trí riêng, không sửa từ đây.
  const isEmpty = isArrayPath(l.path) && !(elementValue(spine, l.path) as unknown[] | undefined)?.length
  const how = !isArrayPath(l.path)
    ? ""
    : isEmpty
      ? "\n  EMPTY SECTION — the only valid edit is adding new elements to this array (`add` ops)."
      : "\n  ADD NEW — the only valid edit is adding new elements to this array (`add` ops) that the change needs and that do not exist yet (value above = existing elements, for ids and to avoid duplicates). Existing elements are separate locations. Nothing new needed ⇒ not_related."
  // Mode 1 v3: op người yêu cầu đã xem trước cho đúng vị trí này — gợi ý, AI vẫn tự kết luận
  const mine = seedOpsFor(seedOps, l.path)
  const suggested = mine.length ? `\n  Requester's previewed ops for this location (suggestion): ${JSON.stringify(mine)}` : ""
  return `[${l.location_id}] ${l.path} (section: ${section}; ${why})\n  ${value}${how}${suggested}${failed}`
}

/**
 * Mục đích của CR + mọi ô "thêm mới" của nó — gửi cho **mọi lô** C-4 (lô chia theo step sở hữu, ô thêm mới của mục
 * khác nằm ở lô khác). Thiếu dòng này model ở lô "màn hình" / "NFR" tự nhét nội dung mới vào phần tử của mình
 * (2026-09-24: bảng phân quyền rơi vào NFR-07 và thành mục riêng từ vị trí tác nhân).
 */
export const targetSectionsText = (spine: Spine, cr: Pick<IChangeRequest, "targets">, locations: readonly Pick<IChangeLocation, "path" | "section_id">[]): string => {
  const sections = cr.targets.entity_paths.filter(isSectionTarget).map((id) => `- ${titleOfSection(spine, id)}`)
  const slots = locations.filter((l) => isArrayPath(l.path)).map((l) => `- new ${l.path.slice(0, -2)} go to "${titleOfSection(spine, l.section_id)}" (location ${l.path})`)
  if (!sections.length && !slots.length) return "(none named)"
  return [...(sections.length ? ["Sections this change targets:", ...sections] : []), ...(slots.length ? ["Where new elements are added (and only there):", ...slots] : [])].join("\n")
}

const needsProposal = (l: IChangeLocation): boolean => !l.manual && (l.conclusion === null || (l.verify !== null && !l.verify.code_ok))

/** Số lượt gọi AI tối đa cho một lô: lượt đầu + một lượt chỉ cho vị trí model bỏ sót. */
export const PROPOSE_ATTEMPTS = 2

type ProposalOut = CrProposeOutput["locations"][number]

/**
 * Ghép output C-4 với vị trí của lô. Chạy thật (e2e P3) thấy model đôi khi đánh số lại `location_id` theo thứ tự
 * trong lô (trả `L001`, `L002` cho lô `L005`, `L006`) ⇒ khớp theo `location_id`, rồi theo `path`; phần output còn
 * lại khớp theo thứ tự **chỉ khi** số lượng bằng đúng số vị trí còn thiếu (không đoán khi lệch).
 */
export const matchProposals = <L extends { location_id: string; path: string }>(batch: readonly L[], outputs: readonly ProposalOut[]): Map<L, ProposalOut> => {
  const matched = new Map<L, ProposalOut>()
  const leftover: ProposalOut[] = []
  for (const out of outputs) {
    const loc = batch.find((l) => !matched.has(l) && (l.location_id === out.location_id || l.path === out.location_id))
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
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })

  const todo = locations.filter(needsProposal)
  const byOwner = new Map<string, IChangeLocation[]>()
  for (const l of todo) byOwner.set(l.owner_step ?? "", [...(byOwner.get(l.owner_step ?? "") ?? []), l])
  for (const [owner, group] of byOwner) {
    const queue: IChangeLocation[][] = []
    for (let i = 0; i < group.length; i += PROPOSE_BATCH) queue.push(group.slice(i, i + PROPOSE_BATCH))
    while (queue.length) {
      // Model bỏ sót vị trí ⇒ gọi lại một lần cho riêng phần thiếu; vẫn thiếu thì để `conclusion = null` (sửa tay)
      let batch = queue.shift()!
      for (let attempt = 0; attempt < PROPOSE_ATTEMPTS && batch.length > 0; attempt++) {
        const result = await withMeteredAi<CrProposeOutput>({ projectId: String(cr.projectId), userId, stepId: `C-4:${cr.cr_id}` }, ActionType.CR_PROPOSE, {
          ...crHeader(cr),
          answers: answersText(cr),
          owner_skill: ownerSkillText(owner || null),
          target_sections: targetSectionsText(spine, cr, locations),
          materials: materialsText(cr),
          missing_info: missingInfoText(cr),
          locations: batch.map((l) => locationPromptText(spine, l, cr.seed?.ops ?? [])).join("\n"),
          glossary: glossaryText(spine)
        })
        if (!result.ok) {
          if (result.reason !== "credits" && batch.length > 1) {
            // Lô quá nặng cho một lượt gọi (prompt dài ⇒ model suy nghĩ hết ngân sách) ⇒ chia đôi, thử lại từng nửa
            // thay vì dừng cả CR. Hết credit thì vẫn dừng để người dùng nạp rồi resume.
            const half = Math.ceil(batch.length / 2)
            console.warn(`[C-4] ${cr.cr_id}: lô ${batch.length} vị trí lỗi (${result.message}) — chia đôi và thử lại`)
            queue.unshift(batch.slice(0, half), batch.slice(half))
            batch = []
            break
          }
          cr.paused = { reason: result.reason, at: new Date() }
          await cr.save()
          return
        }
        const matched = matchProposals(batch, result.data.locations)
        for (const [loc, out] of matched) {
          const ops = out.conclusion === "not_related" ? [] : out.spine_ops
          loc.conclusion = out.conclusion
          loc.reason = out.reason
          loc.proposal = {
            old_text: valueText(elementValue(spine, loc.path)),
            new_text: out.conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
            comment_text: out.conclusion === "comment" ? (out.comment_text ?? null) : null,
            spine_ops: ops,
            assumptions: out.conclusion === "not_related" ? [] : out.assumptions
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

/**
 * BPMN 3.9 "sửa đề xuất trong step sở hữu field" (mode 1 v3): CR ở `manual_fix` (AI đã làm lại 2 lần vẫn trượt 3.7) ⇒
 * BA ghi hướng sửa, BE chạy **skill của step sở hữu** vị trí đó (như C-4 nhưng một vị trí, kèm hướng của BA). Kết quả chỉ
 * ghi vào **đề xuất** của vị trí (`manual = true`), không ghi Spine; BA chạy lại kiểm (3.7) bằng `/verify`.
 * Mode 1 không chạy step, và phần tử đang bị chính CR này khoá — nên "sửa trong step" là dùng skill của step đó ngay trong CR.
 */
/** Phase 8: "Sửa lại" trong chat dùng chung đường này — mọi bước đã có đề xuất, trước khi nộp. */
export const REDRAFT_CR_STATUSES = ["proposing", "verifying", "manual_fix", "ready_to_submit"] as const

export const draftInOwnerStep = async (cr: IChangeRequest, userId: string, locationId: string, instruction: string): Promise<void> => {
  assertCrStatus(cr, REDRAFT_CR_STATUSES, "verifying")
  const loc = await ChangeLocation.findOne({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: locationId })
  if (!loc) throw new Mode1Error("CR_LOCATION_NOT_FOUND", "Không tìm thấy vị trí cần sửa này")
  // Phase 8: mục riêng (không có step sở hữu) vẫn soạn lại được — AI viết theo hướng của BA, không kèm skill nội dung
  const holder = (await locksOf(cr.projectId, [loc.path])).get(loc.path)
  if (holder !== cr.cr_id) throw pathLocked(holder ? [{ path: loc.path, cr_id: holder }] : [])

  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)
  const result = await withMeteredAi<CrProposeOutput>({ projectId: String(cr.projectId), userId, stepId: `C-4:${cr.cr_id}` }, ActionType.CR_PROPOSE, {
    ...crHeader(cr),
    answers: `${answersText(cr)}

Analyst's instruction for ${loc.location_id} (${loc.owner_step ? `fix in owner step ${loc.owner_step}` : "free-form section"}): ${instruction}`,
    owner_skill: ownerSkillText(loc.owner_step),
    target_sections: targetSectionsText(spine, cr, await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).select("path section_id").lean()),
    materials: materialsText(cr),
    missing_info: missingInfoText(cr),
    locations: locationPromptText(spine, loc, cr.seed?.ops ?? []),
    glossary: glossaryText(spine)
  })
  if (!result.ok) {
    // `manual_fix` không phải bước pause được (Flow 4/5 của CR chỉ ở clarifying/proposing/verifying) ⇒ báo lỗi, giữ nguyên
    if (result.reason === "credits") throw new ApiError(402, result.message, "INSUFFICIENT_CREDIT")
    throw new ApiError(502, result.message, "AI_PROVIDER_ERROR")
  }
  const out = matchProposals([loc], result.data.locations).get(loc)
  if (!out) throw new ApiError(502, "AI chưa đưa ra đề xuất cho vị trí này — thử lại hoặc sửa trực tiếp", "AI_PROVIDER_ERROR")
  const ops = out.conclusion === "not_related" ? [] : out.spine_ops
  loc.conclusion = out.conclusion
  loc.reason = out.reason
  loc.proposal = {
    old_text: valueText(elementValue(spine, loc.path)),
    new_text: out.conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
    comment_text: out.conclusion === "comment" ? (out.comment_text ?? null) : null,
    spine_ops: ops,
    assumptions: out.conclusion === "not_related" ? [] : out.assumptions
  }
  loc.manual = true
  loc.verify = null
  await loc.save()
  // Đã đạt kiểm mà soạn lại một vị trí ⇒ phải kiểm lại (như sửa tay)
  if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
}
