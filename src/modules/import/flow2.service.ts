/**
 * FLF-278 trên FLF-335/336 — business-flow "Luồng 1 → Luồng 2" cho **chế độ 3** (dự án mới có mẫu bắt buộc, file thiếu mục).
 *
 * Từ "Kết quả đọc file" (import `incomplete`, 1.10) BA chọn "Viết phần còn thiếu với FlintFlow" thay vì "Hoàn thiện" (v0 từ
 * chính mẫu). Code đưa dự án sang Luồng 2 bằng pipeline tạo mới sẵn có, vào thẳng 2.4 (bỏ 2.1–2.3):
 *  - Bước Brief (B-1 … S-1) mở lại để AI phân tích phần đã có + hỏi phần thiếu (2.4–2.7); B-0 (nhập ý tưởng, chọn ngôn ngữ,
 *    hồ sơ) giữ bỏ qua — đã có từ file.
 *  - Bước sở hữu mục thiếu đã `pending` từ kế hoạch step lúc import; mục đã có giữ `accepted`, mục mẫu không có giữ `skipped`
 *    (2.8 "AI drafts each missing step").
 *  - `Project.mode = fpt` (luồng tạo mới) ⇒ chạy step, ký baseline như dự án tạo mới; bản in vẫn theo layout của mẫu
 *    (`loadTemplateLayout` + `fixedTemplate`, 2.10). Ký baseline 1.0 ⇒ FLF-318 (`convert-from-fpt`) đưa dự án về mode 1,
 *    sửa sau đó qua change request (Luồng 3).
 * Chế độ 4 (SRS tự do, cần xem trước bố cục 2.9a) chưa hỗ trợ.
 */

import { Project } from "../project/project.model.js"
import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { loadStepRegistry, orderedSteps } from "../pipeline/step-registry.js"
import { Mode1Error } from "./mode1.errors.js"
import { assertImportStatus, requireImport, transitionImport } from "./import.service.js"
import { TemplateProfile } from "./template-profile.model.js"

/** Pha Brief mở lại khi sang Luồng 2 (business-flow 2.4–2.7). B-0 = 2.1–2.3, bỏ qua với chế độ 3/4. */
const FLOW2_BRIEF_PHASES: ReadonlySet<string> = new Set(["B-1", "B-2", "S-1"])

/**
 * Op mở lại bước Brief + đặt bước kế tiếp (hàm thuần). Bước đã `accepted` / bước sở hữu mục thiếu đã `pending` giữ nguyên.
 */
export const flow2StepOps = (spine: Pick<Spine, "steps" | "screens" | "functions">): Op[] => {
  const brief = new Set(loadStepRegistry().filter((s) => FLOW2_BRIEF_PHASES.has(s.phase)).map((s) => s.id))
  const reopened = new Set(spine.steps.filter((s) => brief.has(s.id) && s.status === "skipped").map((s) => s.id))
  const statusOf = (id: string) => (reopened.has(id) ? "pending" : (spine.steps.find((s) => s.id === id)?.status ?? "pending"))
  const next = orderedSteps(spine).find((st) => statusOf(st.id) !== "accepted" && statusOf(st.id) !== "skipped")
  return [
    ...[...reopened].map((id): Op => ({ op: "set", path: `steps[id=${id}].status`, value: "pending" })),
    { op: "set", path: "progress.current_phase", value: next?.phase ?? null },
    { op: "set", path: "progress.current_step", value: next?.id ?? null }
  ]
}

export interface Flow2Body {
  import_id: string
  base_version: number
}

export interface Flow2Result {
  project_mode: "fpt"
  import_state: "drafting"
  current_step: string | null
  spine_version: number
}

export const continueInFlow2 = async (projectId: string, userId: string, body: Flow2Body): Promise<Flow2Result> => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["incomplete"], "drafting")
  const project = await Project.findById(projectId).lean()
  const profile = await TemplateProfile.findOne({ projectId }).lean()
  const mode = profile?.target_structure?.resolved_mode
  if (project?.template_intent !== "fixed" || mode !== 3) {
    throw new Mode1Error(
      "IMPORT_INVALID_STATE",
      "Chỉ dự án theo mẫu bắt buộc còn thiếu mục mới viết tiếp được bằng FlintFlow (chế độ SRS tự do cần xem trước bố cục — chưa hỗ trợ)",
      { status: doc.status, resolved_mode: mode ?? null }
    )
  }
  const spine = await spineRepository.get(projectId)
  if (!spine) throw new Mode1Error("IMPORT_INVALID_STATE", "Dự án chưa có dữ liệu tài liệu", { status: doc.status })
  const applied = await applyTransaction(projectId, {
    base_version: body.base_version,
    ops: flow2StepOps(spine),
    by: userId,
    reason: "Luồng 2: viết phần còn thiếu của mẫu bắt buộc",
    step_id: null
  })
  // Bước cuối: đổi luồng. Ngôn ngữ tài liệu = ngôn ngữ của file mẫu (dự án tải file lên không có `documentLanguage`)
  await transitionImport(doc, "drafting")
  await Project.updateOne(
    { _id: projectId, mode: "import" },
    { $set: { mode: "fpt", ...(project.documentLanguage ? {} : { documentLanguage: profile?.language === "vi" ? "vi" : "en" }) } }
  )
  return { project_mode: "fpt", import_state: "drafting", current_step: applied.spine.progress.current_step ?? null, spine_version: applied.spine.spine_version }
}
