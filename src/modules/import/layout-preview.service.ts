/**
 * layout-preview.service.ts — FLF-461, business-flow bước 2.9a (chế độ 4, §3.1.2 + §5.4): xem trước bố cục mới của tài liệu
 * (mục FlintFlow soạn thêm chèn đúng vị trí mẫu chuẩn, mục **Ngoài phạm vi** giữ nguyên nội dung và chuyển xuống cuối), người
 * dùng xác nhận rồi bản in mới được áp (`render/source-fidelity.ts` `rearrangeOf` chỉ áp khi `layout_confirmed_at` có giá trị).
 * Chế độ 3 giữ đúng thứ tự mẫu, không có bước này.
 *
 * Danh sách xem trước dựng bằng đúng hàm đặt mục của bản in (`placeSections`) nên khớp với file xuất ra.
 */

import { Project } from "../project/project.model.js"
import { loadTemplateLayout } from "../render/assemble.service.js"
import { placeSections } from "../render/layout-sections.js"
import { RenderedDocumentCache } from "../render/rendered-document.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Mode1Error } from "./mode1.errors.js"
import { sectionTitle } from "./section-catalog.js"
import { TemplateProfile } from "./template-profile.model.js"

export interface LayoutPreviewItem {
  section_id: string
  title: string
  level: number
  /** `file` = mục của file khách · `added` = mục FlintFlow soạn thêm · `out_of_scope` = Ngoài phạm vi, chuyển xuống cuối. */
  origin: "file" | "added" | "out_of_scope"
}

export interface LayoutPreview {
  /** Chỉ chế độ 4 đã vào Luồng 2 mới có bước xem trước bố cục. */
  applicable: boolean
  confirmed_at: string | null
  sections: LayoutPreviewItem[]
}

const NOT_APPLICABLE: LayoutPreview = { applicable: false, confirmed_at: null, sections: [] }

export const getLayoutPreview = async (projectId: string): Promise<LayoutPreview> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { mode: 1, template_intent: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { target_structure: 1, flow2_entry_at: 1, layout_confirmed_at: 1 }).lean()
  ])
  const structure = profile?.target_structure
  if (!project || project.mode === "import" || project.template_intent !== "free" || !profile?.flow2_entry_at || structure?.resolved_mode !== 4) return NOT_APPLICABLE
  const [spine, template] = await Promise.all([spineRepository.get(projectId), loadTemplateLayout(projectId)])
  if (!spine || !template) return NOT_APPLICABLE

  const outOfScope = new Set(structure.sections.filter((s) => s.status === "out_of_scope").map((s) => s.section_id))
  const added = new Set(structure.sections.filter((s) => s.status === "missing").map((s) => s.section_id))
  const placed = placeSections(spine, { ...template, moveToEnd: [...outOfScope] })

  const sections: LayoutPreviewItem[] = []
  let movedLevel: number | null = null
  for (const p of placed) {
    // Mục con / phần nối của mục Ngoài phạm vi đi cùng mục cha xuống cuối
    if (outOfScope.has(p.section_id)) movedLevel = p.level
    else if (movedLevel !== null && p.level <= movedLevel && p.kind !== "continuation") movedLevel = null
    if (p.kind === "continuation") continue
    const origin = movedLevel !== null ? "out_of_scope" : added.has(p.section_id) || !p.fromLayout ? "added" : "file"
    sections.push({ section_id: p.section_id, title: p.title.trim() || sectionTitle(p.section_id), level: p.level, origin })
  }
  return { applicable: true, confirmed_at: profile.layout_confirmed_at ? new Date(profile.layout_confirmed_at).toISOString() : null, sections }
}

/** Người dùng xác nhận bố cục mới ⇒ từ giờ bản in sắp lại theo bố cục đó. Gọi lại khi đã xác nhận ⇒ giữ mốc cũ. */
export const confirmLayout = async (projectId: string): Promise<LayoutPreview> => {
  const preview = await getLayoutPreview(projectId)
  if (!preview.applicable) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chỉ chế độ hoàn thiện SRS dang dở mới có bước xem trước bố cục", { applicable: false })
  }
  if (!preview.confirmed_at) {
    await TemplateProfile.updateOne({ projectId, layout_confirmed_at: null }, { $set: { layout_confirmed_at: new Date() } })
    // Bản dựng cache theo `spine_version`, mà xác nhận không đổi Spine ⇒ bỏ cache để lần tải sau theo bố cục mới
    await RenderedDocumentCache.deleteMany({ projectId })
  }
  return getLayoutPreview(projectId)
}
