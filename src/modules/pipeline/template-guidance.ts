/**
 * FLF-378 (luồng C, C2.2–C2.4): đưa **mẫu bắt buộc** của khách vào prompt của bước soạn.
 *
 * `TemplateProfile.template_context` (finalize ghi): khung mẫu ⇒ mọi mục của mẫu; SRS viết dở giữ khung (luồng B, FLF-382) ⇒ chỉ mục
 * còn thiếu. Mỗi bước nhận:
 * - Brief (B-1, B-2, S-1): toàn bộ mẫu — tóm tắt mẫu yêu cầu gì, hỏi phần thiếu; đoạn chưa rõ được xếp thành ngữ cảnh / ví dụ
 *   bằng cách so với thông tin dự án (`classifyPassages`).
 * - Bước soạn S-x: các mục mẫu bước đó sở hữu (`templateSectionOwnerSteps`) — `Template guidance`, `Template example` (không
 *   chép), `Template context`, cột bảng mẫu, "nội dung nên có" ISO 29148.
 * - Mục riêng của mẫu (`custom:*`, C2.4): bước sở hữu (S-8.1) được ghi `custom_sections[id=…]` và thấy mục đó trong projection.
 */

import mongoose from "mongoose"
import type { CustomSection, Spine } from "../spine/spine.types.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { templatePromptBlock, type ProjectFacts, type TemplateContextEntry } from "../import/template-context.js"
import { SLOT_FALLBACK_OWNER, templateSectionOwnerSteps } from "../import/template-step-headings.js"
import { expectedContentOf, skillOfSection } from "../import/part-bank.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"

/** Pha đọc cả mẫu (Brief mở lại ở Luồng 2). */
const WHOLE_TEMPLATE_PHASES = ["B-1", "B-2", "S-1"]

const isWholeTemplateStep = (stepId: string): boolean => WHOLE_TEMPLATE_PHASES.some((p) => stepId.startsWith(`${p}.`))

export const projectFactsOf = (spine: Pick<Spine, "project">): ProjectFacts => ({
  name: spine.project.system_name ?? spine.project.name,
  texts: [spine.project.name, spine.project.vision, spine.project.domain, ...(spine.project.goals ?? [])]
})

/** Mục mẫu một bước đọc: Brief ⇒ cả mẫu; bước soạn ⇒ mục bước đó (hoặc bước mẫu của vòng S-5) sở hữu. */
export const templateEntriesForStep = (entries: readonly TemplateContextEntry[], stepId: string, spine?: Spine): TemplateContextEntry[] => {
  if (isWholeTemplateStep(stepId)) return [...entries]
  const base = stepId.split("@")[0]
  return entries.filter((e) => templateSectionOwnerSteps(e.section_id, spine).some((owner) => owner === stepId || owner === base))
}

export interface TemplateStepContext {
  /** Khối prompt nối vào `content_guidance`; "" khi không phải dự án mẫu bắt buộc mới / bước không sở hữu mục mẫu nào. */
  guidance: string
  /** Mục riêng của mẫu bước này soạn (C2.4) — thêm vào projection + đường ghi. */
  customSections: Pick<CustomSection, "id" | "heading" | "level" | "blocks">[]
  /** Phần nhỏ không có bước pipeline (References / Verification) bước này soạn — đường ghi thêm + dữ liệu hiện có. */
  slotWrites: string[]
  slotProjection: Record<string, unknown>
}

const CUSTOM_WRITE_RULE = [
  "### Template-specific sections (custom_sections)",
  "Some template sections have no FlintFlow data model. Draft each one for THIS project by replacing the WHOLE element",
  "(the op engine rejects setting `.blocks` alone) - keep its id, heading and level exactly as shown in the projection:",
  '`{"op":"set","path":"custom_sections[id=<id>]","value":{"id":"<id>","heading":"<heading>","level":<level>,"source":"import","blocks":[{"kind":"paragraph","text":"…","rows":null,"image_ref":null}]}}`.',
  'Use `"kind":"list_item"` for bullets and `{"kind":"table","text":"","rows":[[header…],[row…]],"image_ref":null}` for a table that',
  "keeps the template's columns. Never copy the template's example text."
].join("\n")

const BRIEF_RULE = [
  "### Using the customer template in the Brief",
  "- Summarize, in the user's language, what the template requires (its sections and what each must contain).",
  "- Facts marked Template context belong to this project: reuse them instead of asking again.",
  "- Template example text describes another system: never treat it as this project's facts.",
  "- Ask the user for what the template requires that the project has not provided yet."
].join("\n")

/** Hàm thuần — dựng khối prompt từ ngữ cảnh mẫu đã nạp. */
export const buildTemplateStepContext = (
  entries: readonly TemplateContextEntry[] | null | undefined,
  stepId: string,
  spine: Spine
): TemplateStepContext => {
  if (!entries?.length) return { guidance: "", customSections: [], slotWrites: [], slotProjection: {} }
  const own = templateEntriesForStep(entries, stepId, spine)
  const whole = isWholeTemplateStep(stepId)
  const customIds = whole ? new Set<string>() : new Set(own.filter((e) => e.section_id.startsWith("custom:")).map((e) => e.section_id.slice("custom:".length)))
  const customSections = spine.custom_sections.filter((c) => customIds.has(c.id)).map(({ id, heading, level, blocks }) => ({ id, heading, level, blocks }))
  const block = templatePromptBlock(own, projectFactsOf(spine), expectedContentOf)
  const brief = whole && block ? BRIEF_RULE : ""
  // C2.4: phần nhỏ mẫu IEEE không có bước pipeline ⇒ skill của ngân hàng phần + được ghi đúng chỗ của nó trong Spine
  const slots = whole ? [] : own.filter((e) => SLOT_FALLBACK_OWNER[e.section_id]?.step === stepId.split("@")[0])
  const slotWrites = [...new Set(slots.flatMap((e) => SLOT_FALLBACK_OWNER[e.section_id].writes))]
  const slotProjection = Object.fromEntries(slotWrites.map((w) => [w, (spine as unknown as Record<string, unknown>)[w] ?? []]))
  const skills = [...new Set(slots.map((e) => skillOfSection(e.section_id)).filter((s): s is string => !!s))].map((name) => {
    try {
      const skill = getSkill(name)
      return skill.stub ? "" : `## Skill for template section (${name})\n\n${skill.template}`
    } catch {
      return ""
    }
  })
  const guidance = [block, brief, ...skills, customSections.length ? CUSTOM_WRITE_RULE : ""].filter(Boolean).join("\n\n")
  return { guidance, customSections, slotWrites, slotProjection }
}

/** Nạp `template_context` của dự án (null ⇒ không phải dự án theo mẫu cần soạn). */
export const loadTemplateContext = async (projectId: string): Promise<TemplateContextEntry[] | null> => {
  // Chưa nối Mongo (unit test của pipeline giả Spine, không có DB) ⇒ không chờ buffer của mongoose
  if (mongoose.connection.readyState !== 1) return null
  const profile = await TemplateProfile.findOne({ projectId }, { template_context: 1 }).lean()
  return (profile?.template_context as TemplateContextEntry[] | null | undefined) ?? null
}
