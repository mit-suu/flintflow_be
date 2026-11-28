/**
 * Dữ liệu ngoài Spine mà hình cần khi vẽ / so hash (`RenderContext`): ký pháp ERD, theme mockup màn và trạng thái mockup ảnh gốc của dự án. Nạp theo `projectId`
 * ở mọi nơi vẽ hoặc kiểm `diagram_stale` — thiếu field / chưa nối DB ⇒ mặc định (`chen`).
 */

import mongoose from "mongoose"
import { erdNotationOf, type RenderContext } from "../../shared/diagram/erd-notation.js"
import { screenMockupsOf, screenThemeOf } from "../../shared/diagram/screen-theme.js"
import { sequenceLevelOf } from "../../shared/diagram/sequence-level.js"
import { Project } from "../project/project.model.js"
import { diagramIncluded, stateMachineAllowed } from "../../shared/diagram/diagram-inclusion.js"
import { TemplateProfile } from "../import/template-profile.model.js"

export const loadRenderContext = async (projectId: string): Promise<RenderContext> => {
  // Test đơn vị không nối Mongo: không chờ buffer của mongoose
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return {}
  const project = await Project.findById(projectId).select("erdNotation sequenceLevel screenTheme screenMockups classDiagram sequenceDiagram").lean()
  const profile = (await TemplateProfile.findOne({ projectId }, { template_family: 1 }).lean()) as { template_family?: string | null } | null
  return {
    erdNotation: erdNotationOf(project),
    sequenceLevel: sequenceLevelOf(project),
    screenTheme: screenThemeOf(project),
    screenMockups: screenMockupsOf(project),
    // FLF-441: chỉ ghi khi dự án tắt — giữ nguyên context (và hash) của dự án cũ
    ...(diagramIncluded(project, "class") ? {} : { classDiagram: false }),
    ...(diagramIncluded(project, "sequence") ? {} : { sequenceDiagram: false }),
    // FLF-441: State Machine chỉ có ở mẫu IEEE — tạo SRS mới không tải mẫu / mẫu FPT ⇒ không vẽ
    ...(stateMachineAllowed(profile?.template_family) ? {} : { stateMachine: false })
  }
}
