/**
 * FLF-395 (D3) — dự án theo bản cũ của mẫu tổ chức ⇒ chi tiết project trả `template_update` để FE hiện thông báo + nút cập
 * nhật. Chỉ Lead / Analyst (Viewer không đổi mẫu được ⇒ `null`). Một truy vấn theo `orgId` của project.
 */
import type { OrgRole } from "../organization/membership.model.js"
import type { IProject } from "../project/project.model.js"
import { OrgTemplate } from "./org-library.model.js"

export interface TemplateUpdate {
  template_id: string
  name: string
  current_version: number
  latest_version: number
}

const CAN_UPDATE: ReadonlySet<string> = new Set(["lead", "analyst"])

export const templateUpdateOf = async (project: Pick<IProject, "template_ref" | "organizationId">, role: OrgRole | undefined): Promise<TemplateUpdate | null> => {
  const ref = project.template_ref
  if (!ref || !role || !CAN_UPDATE.has(role) || !project.organizationId) return null
  const family = await OrgTemplate.findOne({ _id: ref.template_id, orgId: project.organizationId }).select("name latest_version skeleton_of").lean()
  // Khung tự lưu của dự án khác: bản mới chỉ thuộc dự án nguồn (chốt 10/11)
  if (!family || family.skeleton_of || family.latest_version <= ref.version) return null
  return { template_id: String(family._id), name: family.name, current_version: ref.version, latest_version: family.latest_version }
}

/** Mẫu dự án đang theo — để thẻ "Mẫu tài liệu" ghi tên + bản. `kind`: mẫu thư viện, khung tự lưu, hay bản riêng của dự án (file tải lên lúc đổi mẫu). */
export interface TemplateCurrent {
  template_id: string
  name: string
  version: number
  kind: "org" | "skeleton" | "project"
}

/** `null` khi dự án theo file mẫu của chính nó (chưa gắn mẫu tổ chức) hoặc họ mẫu không còn. Mọi thành viên đọc được (chỉ là nhãn). */
export const templateCurrentOf = async (project: Pick<IProject, "template_ref" | "organizationId">): Promise<TemplateCurrent | null> => {
  const ref = project.template_ref
  if (!ref || !project.organizationId) return null
  const family = await OrgTemplate.findOne({ _id: ref.template_id, orgId: project.organizationId }).select("name skeleton_of project_id").lean()
  if (!family) return null
  return { template_id: String(family._id), name: family.name, version: ref.version, kind: family.project_id ? "project" : family.skeleton_of ? "skeleton" : "org" }
}
