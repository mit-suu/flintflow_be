/**
 * section-progress.ts — FLF-461, business-flow §1.1 cột "3, 4": tiến độ của chế độ 3/4 là **số mục còn cần xử lý**, không đếm 12
 * giai đoạn. "Mục cần xử lý" = mục của cấu trúc đích mà file còn thiếu (`target_structure`, trạng thái `missing`); mục đó còn
 * việc khi một bước sở hữu nó chưa chốt (chưa `accepted` / `skipped`). Mục khách đã viết, mục Ngoài phạm vi, Record of Changes
 * không tính.
 */

import { Project } from "../project/project.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { StepState } from "../spine/spine.types.js"
import { entersFlow2 } from "./flow2.service.js"
import { TemplateProfile } from "./template-profile.model.js"
import { isNonDraftHeading, type TargetSection } from "./target-structure.js"

export interface SectionProgress {
  /** Mục còn cần xử lý. */
  remaining: number
  /** Tổng mục file còn thiếu lúc vào Luồng 2. */
  total: number
}

/** Hàm thuần. */
export const sectionProgressOf = (sections: readonly TargetSection[], steps: readonly Pick<StepState, "id" | "status">[]): SectionProgress => {
  const todo = sections.filter((s) => s.status === "missing" && !isNonDraftHeading(s.section_id, s.title))
  const open = (owner: string) => steps.some((st) => (st.id === owner || st.id.startsWith(`${owner}@`)) && st.status !== "accepted" && st.status !== "skipped")
  return { total: todo.length, remaining: todo.filter((s) => (s.owner_steps ?? []).some(open)).length }
}

/** Dự án chế độ 3/4 đang ở Luồng 2 ⇒ tiến độ theo mục; còn lại `null` (tiến độ theo bước như cũ). */
export const flow2SectionProgress = async (projectId: string): Promise<SectionProgress | null> => {
  const project = await Project.findById(projectId, { mode: 1, template_intent: 1 }).lean()
  if (!project || project.mode === "import") return null
  const profile = await TemplateProfile.findOne({ projectId }, { target_structure: 1 }).lean()
  const structure = profile?.target_structure
  if (!structure || !entersFlow2(project.template_intent, structure.resolved_mode)) return null
  const spine = await spineRepository.get(projectId)
  return spine ? sectionProgressOf(structure.sections, spine.steps) : null
}
