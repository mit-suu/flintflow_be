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
  const family = await OrgTemplate.findOne({ _id: ref.template_id, orgId: project.organizationId }).select("name latest_version").lean()
  if (!family || family.latest_version <= ref.version) return null
  return { template_id: String(family._id), name: family.name, current_version: ref.version, latest_version: family.latest_version }
}
