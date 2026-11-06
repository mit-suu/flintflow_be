/**
 * FLF-382 (luồng B — có sẵn · mẫu cố định): CR "Bổ sung mục còn thiếu" — phần thuần (không DB).
 * - Lời yêu cầu tự sinh theo tiêu đề của file khách, ngôn ngữ tài liệu.
 * - C-3: mỗi mục trống một vị trí "thêm nội dung vào mục" (không trỏ block cũ): mục FPT ⇒ mảng nuôi mục (`SECTION_FILL_ARRAYS`,
 *   `fixed:1` = phần tử `project`); phần nhỏ `slot:*` ⇒ đích của phần (`contentSlot().targets`); mục riêng `custom:*` ⇒ phần
 *   tử `custom_sections[id=…]` (đề xuất đặt `blocks`). Hai mục cùng đường ghi (vd hai mục NFR cùng `nfrs[]`) ⇒ một vị trí,
 *   `entity_paths` liệt kê cả hai (khoá là duy nhất theo path trong một CR).
 * - Nhóm theo phần (skill / step sở hữu) như lô C-4 — dùng để ước tính credit.
 * - C-5: mục nào vẫn trống sau đề xuất (`sectionHasData` / `slotHasData` / khối thật của mục riêng) — báo, không chặn.
 */

import { contentSlot, isContentSlot, slotHasData } from "../import/content-slots.js"
import { expectedContentOf, partOfHeading, skillOfPart, skillOfSection } from "../import/part-bank.js"
import { customSectionsWithContent } from "../import/step-plan.js"
import { fixedSectionArrayFilled } from "../import/target-structure.service.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import { ownerStepOf } from "../spine/section-registry.js"
import type { Spine } from "../spine/spine.types.js"
import { splitInstruction } from "../../shared/utils/instruction-text.js"
import { PROPOSE_BATCH, ownerKeyOf } from "./propose.service.js"
import { PROJECT_PATH, fillPathsOfSection, type FoundLocation } from "./spine-location.js"

export interface GapSection {
  section_id: string
  title: string
}

export type DocLanguage = "vi" | "en"

/** Trần mô tả CR (`createChangeRequestSchema.description`). */
const DESCRIPTION_MAX = 5000

/** Tiêu đề + mô tả CR bổ sung, theo ngôn ngữ tài liệu: "Soạn các mục còn trống của tài liệu: 2.3 User Characteristics, …". */
export const gapFillRequestText = (titles: readonly string[], lang: DocLanguage): { title: string; description: string } => {
  const names = titles.map((t) => t.trim()).filter(Boolean)
  const list = names.join(", ")
  if (lang === "vi") {
    const description = `Soạn các mục còn trống của tài liệu: ${list}. Viết đúng nội dung mẫu yêu cầu cho từng mục, dựa trên dữ liệu đã có trong tài liệu.`
    return { title: "Bổ sung mục còn thiếu", description: description.slice(0, DESCRIPTION_MAX) }
  }
  const description = `Write the sections of the document that are still empty: ${list}. Write what the template asks for in each section, based on the data already in the document.`
  return { title: "Fill in missing sections", description: description.slice(0, DESCRIPTION_MAX) }
}

const customIdOf = (sectionId: string): string | null => (sectionId.startsWith("custom:") ? sectionId.slice("custom:".length) : null)

/** Đường ghi của một mục trống (thuần — mục riêng không kiểm có trong Spine ở đây). Không đổ được ⇒ `[]`. */
export const gapSectionPaths = (sectionId: string): string[] => {
  const custom = customIdOf(sectionId)
  if (custom) return [`custom_sections[id=${custom}]`]
  if (isContentSlot(sectionId)) return (contentSlot(sectionId)?.targets ?? []).map((t) => (t === PROJECT_PATH ? PROJECT_PATH : `${t}[]`))
  if (sectionId === "fixed:1") return [PROJECT_PATH]
  return fillPathsOfSection(sectionId)
}

/** C-3 của CR bổ sung: vị trí theo thứ tự mục; mục không có chỗ ghi (vd `slot:analysis_models`) bị bỏ — C-5 báo vẫn trống. */
export const gapFillLocations = (spine: Pick<Spine, "custom_sections">, sectionIds: readonly string[]): FoundLocation[] => {
  const byPath = new Map<string, FoundLocation>()
  for (const sectionId of sectionIds) {
    const custom = customIdOf(sectionId)
    if (custom && !spine.custom_sections.some((c) => c.id === custom)) continue
    for (const path of gapSectionPaths(sectionId)) {
      const same = byPath.get(path)
      if (same) {
        if (!same.entity_paths.includes(sectionId)) same.entity_paths.push(sectionId)
        continue
      }
      byPath.set(path, {
        path,
        section_id: sectionId,
        found_by: ["spine_link"],
        entity_paths: [sectionId],
        owner_step: sectionId.startsWith("fixed:") ? ownerStepOf(sectionId) : null
      })
    }
  }
  return [...byPath.values()]
}

/**
 * Nhóm vị trí như lô C-4 (`runPropose`): theo step sở hữu / skill của phần (mục riêng theo heading), mỗi nhóm cắt theo
 * `PROPOSE_BATCH`. Trả các lô (mã section của vị trí trong lô).
 */
export const gapFillBatches = (spine: Pick<Spine, "custom_sections">, locations: readonly Pick<FoundLocation, "section_id" | "owner_step">[]): string[][] => {
  const byOwner = new Map<string, string[]>()
  for (const l of locations) {
    const key = ownerKeyOf(spine, l)
    byOwner.set(key, [...(byOwner.get(key) ?? []), l.section_id])
  }
  const batches: string[][] = []
  for (const group of byOwner.values()) for (let i = 0; i < group.length; i += PROPOSE_BATCH) batches.push(group.slice(i, i + PROPOSE_BATCH))
  return batches
}

/** Mục đã có nội dung trong `spine` chưa (cùng tiêu chí với I-5 cho dữ liệu Spine). */
export const gapSectionFilled = (spine: Spine, sectionId: string): boolean => {
  const custom = customIdOf(sectionId)
  if (custom) {
    const section = spine.custom_sections.find((c) => c.id === custom)
    return !!section && customSectionsWithContent([section]).size > 0
  }
  if (isContentSlot(sectionId)) return slotHasData(spine, sectionId)
  const known = sectionHasData(spine, sectionId)
  if (known !== null) return known
  // Mục ngoài bảng kiểm tất định (vd Glossary): theo mảng nuôi mục; không có mảng ⇒ không soi được, coi như đã có
  const arrays = gapSectionPaths(sectionId).filter((p) => p.endsWith("[]"))
  return arrays.length ? fixedSectionArrayFilled(spine, sectionId) : true
}

/** C-5: mục của CR bổ sung vẫn trống trong `spine` (Spine sau khi chạy khô mọi op đề xuất). */
export const emptyGapSections = (spine: Spine, sectionIds: readonly string[]): string[] => sectionIds.filter((id) => !gapSectionFilled(spine, id))

/** Skill soạn mục: theo mục (FPT / phần nhỏ), mục riêng theo heading khớp ngân hàng phần. */
export const gapSectionSkill = (spine: Pick<Spine, "custom_sections">, sectionId: string): string | null => {
  const custom = customIdOf(sectionId)
  if (!custom) return skillOfSection(sectionId)
  const section = spine.custom_sections.find((c) => c.id === custom)
  const part = section ? partOfHeading(section.heading) : null
  return part ? skillOfPart(part) : null
}

const GUIDANCE_CHARS = 1500

/** Hướng dẫn `[ ]`/`{ }` của mẫu cho mục: bảng hướng dẫn theo mục (`templateGuidanceBySection`) + chữ hướng dẫn trong khối mục riêng. */
const guidanceOf = (spine: Pick<Spine, "custom_sections">, sectionId: string, guidance: ReadonlyMap<string, string>, layoutGuidance: readonly string[]): string => {
  const custom = customIdOf(sectionId)
  const own = custom ? (spine.custom_sections.find((c) => c.id === custom)?.blocks ?? []).flatMap((b) => splitInstruction(b.text).guidance) : []
  const parts = [...new Set([guidance.get(sectionId), ...layoutGuidance, ...own].map((g) => g?.trim()).filter((g): g is string => !!g))]
  return parts.join(" · ").slice(0, GUIDANCE_CHARS)
}

/** Cột của bảng mẫu (hàng đầu) trong mục riêng còn trống — đề xuất giữ đúng các cột này. */
const templateColumnsOf = (spine: Pick<Spine, "custom_sections">, sectionId: string): string[][] => {
  const custom = customIdOf(sectionId)
  if (!custom) return []
  const blocks = spine.custom_sections.find((c) => c.id === custom)?.blocks ?? []
  return blocks.filter((b) => b.kind === "table" && b.rows?.length).map((b) => b.rows![0].map((c) => c.trim()))
}

/**
 * Ngữ cảnh mục trống cho C-2 / C-4: tiêu đề theo file, hướng dẫn của mẫu, nội dung nên có (ISO 29148), skill soạn, cột bảng
 * mẫu. `layoutGuidance`: `LayoutEntry.template_guidance` theo mục.
 */
export const gapSectionsContext = (
  spine: Pick<Spine, "custom_sections">,
  sections: readonly GapSection[],
  guidance: ReadonlyMap<string, string> = new Map(),
  layoutGuidance: ReadonlyMap<string, readonly string[]> = new Map()
): string =>
  sections
    .flatMap((s) => {
      const g = guidanceOf(spine, s.section_id, guidance, layoutGuidance.get(s.section_id) ?? [])
      const expected = expectedContentOf(s.section_id)
      const skill = gapSectionSkill(spine, s.section_id)
      const columns = templateColumnsOf(spine, s.section_id)
      return [
        `- "${s.title}"`,
        ...(g ? [`  Template guidance (instructions / examples — never copy them as content): ${g}`] : []),
        ...(expected ? [`  Expected content (ISO 29148): ${expected}`] : []),
        ...(skill ? [`  Writing skill: ${skill}`] : []),
        ...columns.map((cols) => `  Template table columns (keep exactly these, in this order): ${cols.join(" | ")}`),
        // Op engine không nhận `set` vào mảng `blocks` (phần tử là object) ⇒ đặt lại cả phần tử mục riêng
        ...(customIdOf(s.section_id)
          ? [`  How to write: one \`set\` of the whole element \`custom_sections[id=${customIdOf(s.section_id)}]\` — same id, heading, level and source; \`blocks\` = the new content only (drop the guidance blocks)`]
          : [])
      ]
    })
    .join("\n")


/** Luật nhận xét C-5 "mục của CR bổ sung vẫn trống" — vàng, không chặn ghi. */
export const GAP_SECTION_EMPTY_RULE = "gap_section_empty"

/**
 * C-5 (tất định) cho CR bổ sung: mục trong `gapSections` vẫn trống trên Spine sau khi áp mọi đề xuất (`after`) ⇒ một nhận
 * xét gắn vào vị trí của mục đó (mục không có vị trí ⇒ vị trí đầu). Trả theo `location_id`.
 */
export const gapSectionFlags = (
  after: Spine,
  gapSections: readonly string[],
  titles: ReadonlyMap<string, string>,
  locations: readonly { location_id: string; section_id: string; entity_paths: readonly string[] }[]
): Map<string, { rule: string; message: string }[]> => {
  const out = new Map<string, { rule: string; message: string }[]>()
  for (const sectionId of emptyGapSections(after, gapSections)) {
    const title = titles.get(sectionId)?.trim()
    const message = `Mục ${title ? `"${title}"` : "này"} vẫn còn trống sau đề xuất — xác nhận thì mục vẫn trống trong bản mới (còn trong gap report).`
    const own = locations.filter((l) => l.section_id === sectionId || l.entity_paths.includes(sectionId))
    for (const l of own.length ? own : locations.slice(0, 1)) out.set(l.location_id, [...(out.get(l.location_id) ?? []), { rule: GAP_SECTION_EMPTY_RULE, message }])
  }
  return out
}

/**
 * Mục trống CR soạn được — có ít nhất một đường ghi. Heading tính năng (`feature:*`, nội dung là các chức năng con) hay phần
 * nhỏ không có dữ liệu Spine riêng (`slot:analysis_models`) không có chỗ ghi ⇒ không đưa vào CR (vẫn ở gap report).
 */
export const fillableGapSections = (spine: Pick<Spine, "custom_sections">, sectionIds: readonly string[]): string[] =>
  sectionIds.filter((id) => gapFillLocations(spine, [id]).length > 0)
