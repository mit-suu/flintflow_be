/**
 * Dữ liệu ngoài Spine mà hình cần khi vẽ / so hash (`RenderContext`): hiện là ký pháp ERD của dự án. Nạp theo `projectId`
 * ở mọi nơi vẽ hoặc kiểm `diagram_stale` — thiếu field / chưa nối DB ⇒ mặc định (`chen`).
 */

import mongoose from "mongoose"
import { erdNotationOf, type RenderContext } from "../../shared/diagram/erd-notation.js"
import { Project } from "../project/project.model.js"

export const loadRenderContext = async (projectId: string): Promise<RenderContext> => {
  // Test đơn vị không nối Mongo: không chờ buffer của mongoose
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return {}
  const project = await Project.findById(projectId).select("erdNotation").lean()
  return { erdNotation: erdNotationOf(project) }
}
