/**
 * Business-flow "Luồng 1 → Luồng 2" cho **chế độ 3** (file giữ khung — `template_intent = fixed` — còn thiếu mục).
 *
 * File thiếu cấu trúc đích **không có bản gốc 0.1** (D4, quyết định 26/09): sau I-5 finalize tự đưa dự án sang Luồng 2 bằng
 * pipeline tạo mới sẵn có, vào thẳng 2.4 (bỏ 2.1–2.3) — áp dụng cho cả khung mẫu lẫn SRS có sẵn viết dở:
 *  - Bước Brief (B-1 … S-1) mở lại để AI phân tích phần đã có + hỏi phần thiếu (2.4–2.7); B-0 (nhập ý tưởng, chọn ngôn ngữ,
 *    hồ sơ) giữ bỏ qua — đã có từ file.
 *  - Khung mẫu (FLF-378 luồng C): file là **mẫu**, không phải dữ liệu ⇒ bước sở hữu của mọi mục mẫu `pending`.
 *  - SRS đã viết: chỉ bước sở hữu mục còn thiếu `pending`; bước sở hữu mục khách đã viết giữ `accepted`. Spine lúc vào Luồng 2
 *    được lưu làm mốc để bản in vẫn giữ nguyên văn file gốc cho mục chưa đổi (`render/source-fidelity.ts`).
 *  - `Project.mode = fpt` (luồng tạo mới) ⇒ chạy step, ký baseline như dự án tạo mới; bản in điền vào chính file của khách
 *    (`fixedTemplate`, 2.10). Ký baseline 1.0 ⇒ FLF-318 (`convert-from-fpt`) đưa dự án về mode 1, sửa qua change request.
 * Chế độ 4 (bổ sung theo mẫu chuẩn, cần xem trước bố cục 2.9a) chưa hỗ trợ — dừng ở `incomplete` (gap report + DRAFT).
 */

import { Project } from "../project/project.model.js"
import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { loadStepRegistry, orderedSteps } from "../pipeline/step-registry.js"
import { Mode1Error } from "./mode1.errors.js"
import { assertImportStatus, requireImport, transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { isTemplateFile } from "./structure-preview.js"
import { TemplateProfile } from "./template-profile.model.js"
import { isNonDraftHeading, type TargetSection } from "./target-structure.js"

/** Pha Brief mở lại khi sang Luồng 2 (business-flow 2.4–2.7). B-0 = 2.1–2.3, bỏ qua với chế độ 3/4. */
const FLOW2_BRIEF_PHASES: ReadonlySet<string> = new Set(["B-1", "B-2", "S-1"])

/**
 * Op mở lại bước Brief + bước sở hữu mục cần soạn, rồi đặt bước kế tiếp (hàm thuần).
 * `templateOwners`: id bước sở hữu các mục cần soạn (`TargetStructure.sections[].owner_steps`); id không mang `@màn` áp cho mọi
 * vòng S-5. Bước sở hữu đang `accepted` / `skipped` ⇒ `pending` (bỏ mốc chốt); bước khác giữ nguyên.
 * `keepOwners`: bước sở hữu mục khách đã viết — **không bao giờ mở lại**, kể cả khi cũng sở hữu một mục còn thiếu (mục khách
 * viết giữ chốt, không bị soạn đè). Bước giữ chốt mà lúc import còn `pending` (đầu mục có chữ nhưng chưa trích được dữ liệu vào
 * Spine — vd ảnh sơ đồ) ⇒ `accepted` luôn, để pipeline Luồng 2 không chạy bước đó và soạn đè mục khách viết.
 */
export const flow2StepOps = (
  spine: Pick<Spine, "steps" | "screens" | "functions">,
  templateOwners: readonly string[] = [],
  keepOwners: readonly string[] = [],
  acceptedAt: string = new Date().toISOString()
): Op[] => {
  const brief = new Set(loadStepRegistry().filter((s) => FLOW2_BRIEF_PHASES.has(s.phase)).map((s) => s.id))
  const owners = new Set(templateOwners)
  const keep = new Set(keepOwners)
  const owns = (set: ReadonlySet<string>, id: string) => set.has(id) || set.has(id.split("@")[0])
  const ownsTemplateSection = (id: string) => owns(owners, id) && !owns(keep, id)
  const reopened = new Set(spine.steps.filter((s) => brief.has(s.id) && s.status === "skipped").map((s) => s.id))
  const redraft = spine.steps.filter((s) => !reopened.has(s.id) && s.status !== "pending" && ownsTemplateSection(s.id)).map((s) => s.id)
  const pending = new Set([...reopened, ...redraft])
  const settle = spine.steps.filter((s) => !pending.has(s.id) && s.status === "pending" && owns(keep, s.id)).map((s) => s.id)
  const settled = new Set(settle)
  // Mốc chốt như các bước chốt lúc import (cùng lô nạp dữ liệu) — mục không bị coi là cũ hơn dữ liệu của nó
  const importSeq = spine.steps.find((s) => s.status === "accepted" && s.last_seq !== null)
  const statusOf = (id: string) =>
    pending.has(id) ? "pending" : settled.has(id) ? "accepted" : (spine.steps.find((s) => s.id === id)?.status ?? "pending")
  const next = orderedSteps(spine).find((st) => statusOf(st.id) !== "accepted" && statusOf(st.id) !== "skipped")
  return [
    ...[...reopened].map((id): Op => ({ op: "set", path: `steps[id=${id}].status`, value: "pending" })),
    // Vòng mới như gate mở lại bước đã chốt: bỏ mốc first_seq / last_seq / accepted_at
    ...redraft.flatMap((id): Op[] => [
      { op: "set", path: `steps[id=${id}].status`, value: "pending" },
      { op: "set", path: `steps[id=${id}].first_seq`, value: null },
      { op: "set", path: `steps[id=${id}].last_seq`, value: null },
      { op: "set", path: `steps[id=${id}].accepted_at`, value: null }
    ]),
    ...settle.flatMap((id): Op[] => [
      { op: "set", path: `steps[id=${id}].status`, value: "accepted" },
      { op: "set", path: `steps[id=${id}].first_seq`, value: importSeq?.first_seq ?? null },
      { op: "set", path: `steps[id=${id}].last_seq`, value: importSeq?.last_seq ?? null },
      { op: "set", path: `steps[id=${id}].accepted_at`, value: acceptedAt }
    ]),
    { op: "set", path: "progress.current_phase", value: next?.phase ?? null },
    { op: "set", path: "progress.current_step", value: next?.id ?? null }
  ]
}

/**
 * Hàm thuần: bước cần soạn / bước giữ chốt khi sang Luồng 2.
 * - Khung mẫu (`isTemplateFile`): chữ trong file là hướng dẫn / ví dụ ⇒ soạn **mọi mục của mẫu** (trừ Record of Changes, bìa,
 *   mục lục), không giữ bước nào (hồ sơ trước FLF-378 có thể đã đánh `accepted` vì chữ ví dụ).
 * - SRS đã viết: chỉ bước sở hữu mục `missing`; bước sở hữu mục `present` giữ chốt.
 */
export const flow2Owners = (sections: readonly TargetSection[], templateFile: boolean): { draft: string[]; keep: string[] } => {
  const draftable = sections.filter((s) => s.status !== "out_of_scope" && !isNonDraftHeading(s.section_id, s.title))
  const ownersOf = (list: readonly TargetSection[]) => [...new Set(list.flatMap((s) => s.owner_steps ?? []))]
  if (templateFile) return { draft: ownersOf(draftable), keep: [] }
  return { draft: ownersOf(draftable.filter((s) => s.status === "missing")), keep: ownersOf(draftable.filter((s) => s.status === "present")) }
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

/**
 * Lõi chuyển chế độ 3 sang Luồng 2 — finalize gọi ngay sau I-5 (không chờ bấm), `POST /import/continue` gọi cho bản ghi cũ đang
 * `incomplete`. SRS đã viết: lưu **Spine mốc** lúc vào Luồng 2 — bản in giữ nguyên văn file gốc cho mục chưa đổi so với mốc (chế
 * độ 3 không có bản gốc 0.1 để so).
 */
export const enterFlow2 = async (doc: IImportedDocument, by: string, baseVersion?: number): Promise<Flow2Result> => {
  assertImportStatus(doc, ["incomplete"], "drafting")
  const projectId = String(doc.projectId)
  const [project, profile] = await Promise.all([Project.findById(projectId).lean(), TemplateProfile.findOne({ projectId })])
  const mode = profile?.target_structure?.resolved_mode
  if (project?.template_intent !== "fixed" || mode !== 3 || !profile?.target_structure) {
    throw new Mode1Error(
      "IMPORT_INVALID_STATE",
      "Chỉ file giữ khung còn thiếu mục mới viết tiếp được bằng FlintFlow; file bổ sung theo mẫu chuẩn FlintFlow hiện chỉ tải được bản DRAFT và báo cáo thiếu sót",
      { status: doc.status, resolved_mode: mode ?? null }
    )
  }
  const spine = await spineRepository.get(projectId)
  if (!spine) throw new Mode1Error("IMPORT_INVALID_STATE", "Dự án chưa có dữ liệu tài liệu", { status: doc.status })
  const templateFile = isTemplateFile(project, profile)
  const { draft, keep } = flow2Owners(profile.target_structure.sections, templateFile)
  const applied = await applyTransaction(projectId, {
    base_version: baseVersion ?? spine.spine_version,
    ops: flow2StepOps(spine, draft, keep),
    by,
    // Lý do in vào Record of Changes của tài liệu (bản đầu của dự án) — câu cho người đọc tài liệu, không phải tên luồng nội bộ
    reason: templateFile ? "Start drafting from the required template" : "Start completing the missing sections",
    step_id: null
  })
  // Mốc lưu sau khi mở bước thành công (lô trên chỉ đổi trạng thái bước, nội dung giữ nguyên Spine lúc vào) — lô lỗi thì không để
  // lại mốc dở
  if (!templateFile) {
    const { projectId: _p, ...snapshot } = spine
    profile.flow2_entry_spine = snapshot
    profile.flow2_entry_at = new Date()
    profile.markModified("flow2_entry_spine")
    await profile.save()
  }
  // Bước cuối: đổi luồng. Ngôn ngữ tài liệu = ngôn ngữ của file (dự án tải file lên không có `documentLanguage`)
  await transitionImport(doc, "drafting")
  await Project.updateOne(
    { _id: projectId, mode: "import" },
    { $set: { mode: "fpt", ...(project.documentLanguage ? {} : { documentLanguage: profile.language === "vi" ? "vi" : "en" }) } }
  )
  return { project_mode: "fpt", import_state: "drafting", current_step: applied.spine.progress.current_step ?? null, spine_version: applied.spine.spine_version }
}

/** `POST /import/continue` — bản ghi cũ chế độ 3 còn dừng ở `incomplete` (trước khi finalize tự chuyển Luồng 2). */
export const continueInFlow2 = async (projectId: string, userId: string, body: Flow2Body): Promise<Flow2Result> =>
  enterFlow2(await requireImport(projectId, body.import_id), userId, body.base_version)
