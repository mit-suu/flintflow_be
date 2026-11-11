/**
 * C-4 đề xuất cho từng vị trí (nút 3.6, UC-81): `edit` | `comment` | `not_related` + lý do. FLF-171, plan §6 2E.
 * Theo lô vị trí cùng owner step (≤ 12 vị trí/lượt, mỗi lượt giữ credit riêng); prompt = skill `cr-propose` +
 * quy tắc viết của skill nội dung của owner step (`STEP_SKILLS`) + giá trị phần tử + CR. Vị trí sửa tay (`manual`)
 * không bị AI đè; lần làm lại (sau verify trượt) chỉ đề xuất lại vị trí trượt. Gom change group theo section.
 * Mode 1 v2 (FLF-186): vị trí là phần tử Spine, `edit` = op Spine; BE chụp giá trị trước (`old_text`) và sau khi chạy
 * khô op của vị trí (`new_text`) để người duyệt đọc — tài liệu được render lại từ Spine khi ghi (C-7).
 * Mode 1 v3 phase 7: prompt kèm tài liệu bổ sung + dữ kiện C-2 báo thiếu; dữ kiện model phải tự giả định ghi vào
 * `proposal.assumptions` để người duyệt xác nhận ở 3.12.
 * §4.13: vị trí sơ đồ gốc (`found_by: diagram`) không gửi AI — code kết luận sau cùng (`diagram-location.ts`).
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { CrProposeOutput } from "../../shared/ai/response-parser.js"
import { stripRecord } from "../import/check.service.js"
import { titleOfSection } from "../import/gap-report.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { STEP_SKILLS, parseStepId } from "../pipeline/context-projection.js"
import { expectedContentOf, partOfHeading, partsMentionedIn, skillOfPart, skillOfSection } from "../import/part-bank.js"
import { splitInstruction } from "../../shared/utils/instruction-text.js"
import { TemplateProfile, type HeadingMapEntry, type LayoutEntry } from "../import/template-profile.model.js"
import { planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { regroup } from "./group.service.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import { answersText, crHeader, crQuery, glossaryText, missingInfoText, relevantMaterialsText, truncate } from "./cr-context.js"
import { addedElements, elementValue, isArrayPath, isSectionTarget, opElement, snapshotOf, valueText } from "./spine-location.js"
import { isDiagramLocation, refreshDiagramLocations } from "./diagram-location.js"
import { reassignDuplicateIds } from "./new-ids.js"
import { proposeUseCaseBatch } from "./add-use-case.service.js"
import { elementText } from "./location-display.js"
import { directHit } from "./word-diff.js"

/**
 * Số vị trí gửi trong một lượt C-4. Trước là 12: prompt kèm giá trị JSON của từng phần tử (tới 2500 ký tự) và câu
 * trả lời phải có đề xuất + op cho mọi vị trí ⇒ GLM suy nghĩ hết sạch `max_tokens` trước khi kịp trả `content`
 * (`GLM_EMPTY_OUTPUT`, 2026-09-20). Lô nhỏ giữ cả prompt lẫn câu trả lời trong ngân sách; lô nào vẫn lỗi thì
 * `runPropose` tự chia đôi.
 */
export const PROPOSE_BATCH = 4

/** Khoá nhóm vị trí theo skill: step sở hữu, hoặc `skill:<id>` cho mục riêng có heading khớp ngân hàng phần (FLF-363). */
const SKILL_KEY = "skill:"

/**
 * FLF-363 (D4): vị trí trong mục giữ nguyên văn của file (`custom:*`, không step sở hữu) mà heading mục khớp một phần của
 * ngân hàng ("Document Overview", "Sequence Diagrams"…) ⇒ dùng skill của phần đó thay cho "(none)". FLF-364 (L6): heading
 * không khớp ⇒ chữ hướng dẫn của mẫu trong mục nhắc đúng một phần có skill ⇒ skill đó.
 */
export const ownerKeyOf = (spine: Pick<Spine, "custom_sections">, loc: Pick<IChangeLocation, "owner_step" | "section_id">): string => {
  if (loc.owner_step) return loc.owner_step
  // FLF-365: phần nhỏ không có step sở hữu (tham khảo, phân bổ, kiểm chứng) ⇒ skill của phần
  if (loc.section_id?.startsWith("slot:")) {
    const skill = skillOfSection(loc.section_id)
    return skill ? `${SKILL_KEY}${skill}` : ""
  }
  if (!loc.section_id?.startsWith("custom:")) return ""
  const section = spine.custom_sections.find((c) => c.id === loc.section_id.slice("custom:".length))
  if (!section) return ""
  const byHeading = partOfHeading(section.heading)
  const byGuidance = byHeading ? null : partsMentionedIn(section.blocks.flatMap((b) => splitInstruction(b.text).guidance).join(" "))
  const part = byHeading ?? (byGuidance?.length === 1 ? byGuidance[0] : null)
  const skill = part ? skillOfPart(part) : null
  return skill ? `${SKILL_KEY}${skill}` : ""
}

export const ownerSkillText = (ownerKey: string | null): string => {
  if (!ownerKey) return "(none — free-form section kept verbatim from the uploaded file)"
  const skillId = ownerKey.startsWith(SKILL_KEY) ? ownerKey.slice(SKILL_KEY.length) : STEP_SKILLS[parseStepId(ownerKey).base]
  if (!skillId) return "(none)"
  try {
    return truncate(getSkill(skillId).template, 4000)
  } catch {
    return "(none)"
  }
}

/**
 * Giá trị phần tử `path` sau khi chạy khô `rawOps` trên Spine hiện tại — op sai ⇒ `null` (C-5 báo lỗi cụ thể). Vị trí
 * "thêm mới" (`arr[]`) ⇒ chỉ các phần tử được thêm (FLF-308), khớp `old_text = "[]"` của `snapshotOf`.
 */
export const previewAfter = (spine: Spine, path: string, rawOps: readonly unknown[]): string | null => {
  const ops: Op[] = []
  for (const raw of rawOps) {
    const parsed = userOpSchema.safeParse(raw)
    if (!parsed.success) return null
    ops.push(parsed.data)
  }
  const shown = (after: Spine): string =>
    isArrayPath(path) ? valueText(addedElements(elementValue(spine, path), elementValue(after, path))) : valueText(elementValue(after, path))
  if (!ops.length) return shown(spine)
  try {
    return shown(planTransaction(spine, { base_version: spine.spine_version, ops, by: "preview" }, { startSeq: 1 }).spine)
  } catch {
    return null
  }
}

/** FLF-307: id trùng trong op `add` của CR đổi sang id chưa dùng (`new-ids.ts`); vị trí bị đổi tính lại bản xem trước. */
export const fixDuplicateIds = async (spine: Spine, locations: IChangeLocation[]): Promise<void> => {
  for (const l of reassignDuplicateIds(spine, locations)) {
    l.proposal!.new_text = previewAfter(spine, l.path, l.proposal!.spine_ops)
    l.verify = null
    l.markModified("proposal")
    await l.save()
  }
}

/**
 * Mọi id đang có của mảng (giá trị JSON phía trên bị cắt ở 2500 ký tự — mảng 60 use case chỉ thấy vài chục đầu, file
 * upload còn xếp id không theo thứ tự) ⇒ model không đoán id đã dùng. FLF-307.
 */
const existingIdsText = (spine: Spine, path: string): string => {
  const ids = ((elementValue(spine, path) as unknown[] | undefined) ?? []).flatMap((el) =>
    el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string" ? [(el as { id: string }).id] : []
  )
  return ids.length ? `\n  Ids already used (never reuse one): ${truncate(ids.join(", "), 1500)}` : ""
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
      : `\n  ADD NEW — the only valid edit is adding new elements to this array (\`add\` ops) that the change needs and that do not exist yet (value above = existing elements, to avoid duplicates). Existing elements are separate locations. Nothing new needed ⇒ not_related.${existingIdsText(spine, l.path)}`
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
/** Chữ hướng dẫn mẫu của một mục, tối đa ký tự mỗi mục trong prompt C-4. */
const GUIDANCE_PROMPT_CHARS = 1500

/**
 * FLF-364 (L5): chữ hướng dẫn của mẫu upload theo mục — heading của layout (Mode 1) ⇒ `heading_map[].guidance` cùng chữ; heading
 * cha có hướng dẫn thì ghép trước (mục đích của chương). Dự án không có profile (Mode 2) ⇒ rỗng.
 */
export const templateGuidanceBySection = (profile: {
  heading_map: readonly Pick<HeadingMapEntry, "heading_text" | "guidance">[]
  layout?: readonly Pick<LayoutEntry, "heading_text" | "level" | "section_id">[] | null
} | null): Map<string, string> => {
  const out = new Map<string, string>()
  if (!profile?.layout?.length) return out
  const byHeading = new Map(profile.heading_map.filter((h) => h.guidance).map((h) => [h.heading_text.trim(), h.guidance!]))
  const stack: { level: number; guidance: string | null }[] = []
  for (const l of profile.layout) {
    while (stack.length && stack[stack.length - 1].level >= l.level) stack.pop()
    const own = byHeading.get(l.heading_text.trim()) ?? null
    const parent = [...stack].reverse().find((s) => s.guidance)?.guidance ?? null
    stack.push({ level: l.level, guidance: own })
    if (!own) continue
    const text = parent && parent !== own ? `${parent} — ${own}` : own
    const prev = out.get(l.section_id)
    out.set(l.section_id, (prev ? `${prev} · ${text}` : text).slice(0, GUIDANCE_PROMPT_CHARS))
  }
  return out
}

/** Dòng ngữ cảnh mẫu của một mục: hướng dẫn của mẫu upload + nội dung nên có theo 29148. */
const templateLines = (sectionId: string, guidance: ReadonlyMap<string, string>): string[] => {
  const own = guidance.get(sectionId)
  if (!own) return []
  const expected = expectedContentOf(sectionId)
  return [`  Template guidance: ${own}`, ...(expected ? [`  Expected content (ISO 29148): ${expected}`] : [])]
}

export const targetSectionsText = (
  spine: Spine,
  cr: Pick<IChangeRequest, "targets">,
  locations: readonly Pick<IChangeLocation, "path" | "section_id">[],
  guidance: ReadonlyMap<string, string> = new Map()
): string => {
  const sections = cr.targets.entity_paths.filter(isSectionTarget).flatMap((id) => [`- ${titleOfSection(spine, id)}`, ...templateLines(id, guidance)])
  const slots = locations
    .filter((l) => isArrayPath(l.path))
    .flatMap((l) => [`- new ${l.path.slice(0, -2)} go to "${titleOfSection(spine, l.section_id)}" (location ${l.path})`, ...templateLines(l.section_id, guidance)])
  // Mục của vị trí sửa có hướng dẫn mẫu mà không nằm trong hai nhóm trên ⇒ vẫn đưa hướng dẫn (ý người soạn mẫu)
  const named = new Set([...cr.targets.entity_paths.filter(isSectionTarget), ...locations.filter((l) => isArrayPath(l.path)).map((l) => l.section_id)])
  const others = [...new Set(locations.map((l) => l.section_id))]
    .filter((id) => id && !named.has(id) && guidance.has(id))
    .flatMap((id) => [`- ${titleOfSection(spine, id)}`, ...templateLines(id, guidance)])
  if (!sections.length && !slots.length && !others.length) return "(none named)"
  return [
    ...(sections.length ? ["Sections this change targets:", ...sections] : []),
    ...(slots.length ? ["Where new elements are added (and only there):", ...slots] : []),
    ...(others.length ? ["Template guidance of the sections being edited (what the template author wants written there):", ...others] : [])
  ].join("\n")
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
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  // FLF-364: hướng dẫn của mẫu upload theo mục (Mode 1) — ngữ cảnh soạn đúng ý người làm mẫu
  const guidance = templateGuidanceBySection(await TemplateProfile.findOne({ projectId: cr.projectId }).select("heading_map layout").lean())
  let locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })

  // FLF-318: CR thêm / xoá use case ⇒ soạn trọn lô một lượt như chat trước baseline (luật 3e / 3g), vị trí còn
  // lại đề xuất theo lô như dưới. Hết credit ⇒ dừng như C-4.
  const bundled = await proposeUseCaseBatch(cr, userId, spine, locations)
  if (bundled === "paused") return
  if (bundled === "done") {
    // FLF-375 (BF C-4 "mỗi chỗ phải có kết luận + lý do"): vị trí ngoài lô use case KHÔNG còn tự gán "giữ nguyên" —
    // văn xuôi / hình / kiểm chứng còn nhắc phần tử lô vừa xoá hay đổi (vd "UC-05, UC-06, UC-09 có sơ đồ hoạt động") phải
    // được AI xem và đề xuất như mọi CR; người dùng duyệt từng chỗ. Đọc lại vị trí: lô vừa thêm / kết luận vài vị trí.
    locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  }

  // Vị trí sơ đồ gốc (§4.13) không qua AI — kết luận sau khi các vị trí khác có đề xuất (`refreshDiagramLocations`)
  const todo = locations.filter((l) => needsProposal(l) && !isDiagramLocation(l))
  const byOwner = new Map<string, IChangeLocation[]>()
  for (const l of todo) {
    const key = ownerKeyOf(spine, l)
    byOwner.set(key, [...(byOwner.get(key) ?? []), l])
  }
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
          target_sections: targetSectionsText(spine, cr, locations, guidance),
          // FLF-375: chỉ đoạn tài liệu đính kèm liên quan tới CR + các chỗ của lô (Tree-sitter + BM25)
          materials: await relevantMaterialsText(cr, crQuery(cr, ...batch.map((l) => locationPromptText(spine, l, cr.seed?.ops ?? [])))),
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
            proposed_at: new Date(),
            ...snapshotOf(spine, loc.path),
            new_text: out.conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
            comment_text: out.conclusion === "comment" ? (out.comment_text ?? null) : null,
            spine_ops: ops,
            assumptions: out.conclusion === "not_related" ? [] : out.assumptions
          }
          loc.verify = null
          // Đề xuất mới chụp nội dung hiện tại ⇒ xung đột cũ (nếu có, từ lần xác nhận trước) không còn ý nghĩa
          loc.conflict = null
          await loc.save()
        }
        batch = batch.filter((l) => !matched.has(l))
      }
      if (batch.length) console.warn(`[C-4] ${cr.cr_id}: model bỏ sót ${batch.map((l) => l.location_id).join(", ")} sau ${PROPOSE_ATTEMPTS} lượt — chờ sửa tay`)
    }
  }
  await fixDuplicateIds(spine, locations)
  await refreshDiagramLocations(spine, locations)
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

  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  if (isDiagramLocation(loc)) {
    // Sơ đồ gốc (§4.13): không có gì để AI soạn — tính lại theo đề xuất hiện tại của CR (bỏ quyết định tay trước đó).
    // Giữ hình gốc thì kết luận "không liên quan" (PATCH vị trí), không đi đường này.
    loc.manual = false
    const all = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id })
    await refreshDiagramLocations(spine, all.map((l) => (l.location_id === loc.location_id ? loc : l)))
    if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
    return
  }
  // BF §3.2 "AI soạn lại trên nội dung hiện tại": yêu cầu gốc đụng thẳng phần người khác vừa sửa ⇒ hỏi lại trong chat,
  // không gọi AI (không tốn credit), không tự chọn. Người dùng trả lời (chọn gợi ý / gõ) ⇒ gọi lại đường này với câu trả lời.
  if (loc.conflict && !loc.conflict.question && loc.conflict.proposal_text) {
    const text = (json: string) => elementText(JSON.parse(json))
    const hit = directHit(text(loc.conflict.at_proposal_text), text(loc.conflict.current_text), text(loc.conflict.proposal_text))
    if (hit) {
      const who = loc.conflict.changed_by
      loc.conflict.question = {
        text: `${who} vừa đổi “${hit.original}” thành “${hit.theirs}”, còn yêu cầu của bạn muốn đổi thành “${hit.yours}”. Giữ bản nào?`,
        suggestions: [`Dùng “${hit.yours}” theo yêu cầu của tôi`, `Giữ “${hit.theirs}” của ${who} và soạn phần còn lại`]
      }
      loc.markModified("conflict")
      await loc.save()
      return
    }
  }
  // Câu trả lời cho câu hỏi "Giữ bản nào?" là một vòng làm rõ thật sự: C-4 / C-5 / C-2 về sau đều thấy (không hỏi lại
  // "ngưỡng gốc là 1 hay 3?" ở bước kiểm nhất quán)
  if (loc.conflict?.question) {
    cr.clarifications.push({ round: cr.clarifications.length + 1, questions: [loc.conflict.question.text], answers: [instruction], suggestions: [loc.conflict.question.suggestions] })
    cr.markModified("clarifications")
    await cr.save()
  }
  const result = await withMeteredAi<CrProposeOutput>({ projectId: String(cr.projectId), userId, stepId: `C-4:${cr.cr_id}` }, ActionType.CR_PROPOSE, {
    ...crHeader(cr),
    answers: `${answersText(cr)}

Analyst's instruction for ${loc.location_id} (${loc.owner_step ? `fix in owner step ${loc.owner_step}` : "free-form section"}): ${instruction}`,
    owner_skill: ownerSkillText(ownerKeyOf(spine, loc)),
    target_sections: targetSectionsText(
      spine,
      cr,
      await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).select("path section_id").lean(),
      templateGuidanceBySection(await TemplateProfile.findOne({ projectId: cr.projectId }).select("heading_map layout").lean())
    ),
    materials: await relevantMaterialsText(cr, crQuery(cr, instruction, locationPromptText(spine, loc, cr.seed?.ops ?? []))),
    missing_info: missingInfoText(cr),
    locations: locationPromptText(spine, loc, cr.seed?.ops ?? []),
    glossary: glossaryText(spine)
  })
  if (!result.ok) {
    // `manual_fix` không phải bước pause được (Flow 4/5 của CR chỉ ở clarifying/proposing/verifying) ⇒ báo lỗi, giữ nguyên
    if (result.reason === "credits") throw new ApiError(402, result.userMessage, "INSUFFICIENT_CREDIT")
    throw new ApiError(502, result.userMessage, "AI_PROVIDER_ERROR", result.code ? { cause_code: result.code } : undefined)
  }
  const out = matchProposals([loc], result.data.locations).get(loc)
  if (!out) throw new ApiError(502, "AI chưa đưa ra đề xuất cho chỗ này — thử lại, hoặc gõ hướng sửa cụ thể hơn", "AI_PROVIDER_ERROR")
  const ops = out.conclusion === "not_related" ? [] : out.spine_ops
  loc.conclusion = out.conclusion
  loc.reason = out.reason
  loc.proposal = {
    proposed_at: new Date(),
    ...snapshotOf(spine, loc.path),
    new_text: out.conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
    comment_text: out.conclusion === "comment" ? (out.comment_text ?? null) : null,
    spine_ops: ops,
    assumptions: out.conclusion === "not_related" ? [] : out.assumptions
  }
  loc.manual = true
  loc.verify = null
  // FLF-375: "AI soạn lại trên nội dung hiện tại" sau màn so sánh 3 cột ⇒ đề xuất mới chụp nội dung hiện tại, hết xung đột
  loc.conflict = null
  await loc.save()
  // Đã đạt kiểm mà soạn lại một vị trí ⇒ phải kiểm lại (như sửa tay)
  if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
}
