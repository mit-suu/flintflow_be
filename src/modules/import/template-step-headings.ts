/**
 * FLF-278 — rail tiến độ của dự án theo mẫu bắt buộc: bước nào soạn heading nào của mẫu.
 *
 * Rail vẫn là quy trình 12 giai đoạn của FlintFlow (không phải mục lục của mẫu). Để BA biết mỗi bước đang viết vào đâu, `GET
 * /steps` gắn kèm `template_sections` = heading của mẫu (nguyên văn, đúng thứ tự mẫu) mà bước đó soạn. Mapping heading ⇒ mục
 * dùng đúng quy tắc của bản xuất (`bindFixedTemplateHeadings`: phần nhỏ theo tiêu đề, cha / con cùng mục ⇒ heading bao), nên
 * hồ sơ cũ cũng ra cùng kết quả như file Word.
 *
 * Bước sở hữu một phần nhỏ `slot:*` (`slotOwnerSteps`): bước của mục FPT cha có ghi đúng loại dữ liệu của phần nhỏ (vd "1.1
 * Purpose" ⇒ bước ghi `project` của `fixed:1`, không phải bước ghi tác nhân / quy tắc cấp cao). Phần nhỏ không có mục cha
 * (tổng quan chức năng, yêu cầu chức năng, nền tảng) ⇒ mọi bước soạn tài liệu (S-2…S-9) ghi loại dữ liệu đó.
 * Hàm thuần — không đọc DB.
 */

import type { Spine } from "../spine/spine.types.js"
import { stepsOf } from "../spine/section-registry.js"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import { bindFixedTemplateHeadings, contentSlot, isContentSlot } from "./content-slots.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { templateWrapperIds } from "./template-wrappers.js"

/** Giai đoạn phân tích / Brief không soạn mục nào của tài liệu. */
const isDocumentPhase = (phase: string): boolean => phase.startsWith("S-") && phase !== "S-1"

const writesRoot = (writes: readonly string[], root: string): boolean =>
  writes.some((w) => w === root || w.startsWith(`${root}[`) || w.startsWith(`${root}.`))

/** Bước soạn một phần nhỏ (id step mẫu, không mang `@màn`). */
export const slotOwnerSteps = (slotId: string, spine?: Spine): string[] => {
  const slot = contentSlot(slotId)
  if (!slot) return []
  const writers = new Set(
    loadStepRegistry()
      .filter((s) => isDocumentPhase(s.phase) && slot.targets.some((root) => writesRoot(s.writes, root)))
      .map((s) => s.id)
  )
  if (!slot.parents.length) return [...writers]
  const parentSteps = [...new Set(slot.parents.flatMap((p) => stepsOf(p, spine)))]
  const precise = parentSteps.filter((id) => writers.has(id.split("@")[0]))
  // Mục cha không có bước nào ghi đúng loại dữ liệu ⇒ giữ mọi bước của mục cha (như trước)
  return precise.length ? precise : parentSteps
}

/**
 * FLF-378 (C2.4): **mục riêng của mẫu** (`custom:*` — References / Verification khách tự đặt, "Dự toán"…) không có mục FlintFlow
 * tương ứng ⇒ soạn tự do theo hướng dẫn của mẫu ở bước cuối của phần soạn (S-8.1, khi mọi dữ liệu đã có), ghi vào
 * `custom_sections[id=…].blocks`.
 */
export const CUSTOM_SECTION_OWNER_STEP = "S-8.1"

/**
 * FLF-378 (C2.4): phần nhỏ chỉ có ở mẫu IEEE 29148 (FLF-365) mà không bước pipeline nào ghi — soạn bằng skill của ngân hàng
 * phần ở bước có dữ liệu cần thiết: References / Verification ⇒ S-8.1 (ghi `references[]` / `verifications[]`), Apportioning
 * ⇒ S-9.4 (xếp ưu tiên — được ghi `functions` / `nfrs`, nơi có `release` của yêu cầu).
 */
export const SLOT_FALLBACK_OWNER: Readonly<Record<string, { step: string; writes: readonly string[] }>> = {
  "slot:references": { step: CUSTOM_SECTION_OWNER_STEP, writes: ["references"] },
  "slot:verification": { step: CUSTOM_SECTION_OWNER_STEP, writes: ["verifications"] },
  "slot:apportioning": { step: "S-9.4", writes: [] }
}

/** Bước soạn một mục của mẫu (`fixed:*`, `feature:*`, `function:*`, `slot:*` hoặc mục riêng `custom:*`). */
export const templateSectionOwnerSteps = (sectionId: string, spine?: Spine): string[] => {
  if (sectionId.startsWith("custom:")) return [CUSTOM_SECTION_OWNER_STEP]
  if (!isContentSlot(sectionId)) return stepsOf(sectionId, spine)
  const owners = slotOwnerSteps(sectionId, spine)
  const fallback = SLOT_FALLBACK_OWNER[sectionId]
  return owners.length || !fallback ? owners : [fallback.step]
}

const isTemplateSection = (id: string): boolean => id !== "unmapped" && !id.startsWith("group:")

/**
 * Heading của mẫu theo bước. Khoá là id bước như `stepsOf` trả: bước thường (`S-2.1`), bước vòng S-5 theo màn
 * (`S-5.2@S01`) khi mục là function của một màn, hoặc id mẫu (`S-5.2`) khi áp cho mọi vòng — tra bằng `headingsOfStep`.
 */
export const templateSectionsByStep = (layout: readonly LayoutEntry[], spine?: Spine): Map<string, string[]> => {
  const headings = [...layout].sort((a, b) => a.order - b.order).filter((e) => e.heading_text.trim())
  const bound = bindFixedTemplateHeadings(headings)
  const byStep = new Map<string, string[]>()
  const seen = new Set<string>()
  const wrappers = templateWrapperIds(headings)
  for (const entry of bound) {
    // Heading bao của mẫu (chỉ chứa mục con) không phải mục cần soạn
    if (!isTemplateSection(entry.section_id) || wrappers.has(entry.section_id)) continue
    const title = entry.heading_text.trim()
    for (const step of templateSectionOwnerSteps(entry.section_id, spine)) {
      const key = `${step}\u0000${title}`
      if (seen.has(key)) continue
      seen.add(key)
      byStep.set(step, [...(byStep.get(step) ?? []), title])
    }
  }
  return byStep
}

/** Heading của mẫu mà một bước soạn: mục riêng của vòng màn đó trước, rồi mục chung của bước mẫu; giữ thứ tự, bỏ trùng. */
export const headingsOfStep = (byStep: ReadonlyMap<string, readonly string[]>, stepId: string): string[] => {
  const base = stepId.split("@")[0]
  const own = byStep.get(stepId) ?? []
  const shared = base === stepId ? [] : (byStep.get(base) ?? [])
  return [...new Set([...own, ...shared])]
}
