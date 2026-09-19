/**
 * Chặn sửa ngoài change request ở project mode 1 (G9, BR-03). FLF-171, plan §6 2G.
 * Tài liệu .docx + block là nguồn sự thật: sửa Spine trực tiếp (chat ra lệnh sửa, `/changes`, `/reconcile`, `/undo`)
 * làm Spine lệch với file ⇒ trả `409 CHANGE_REQUIRES_CR` kèm nội dung điền sẵn để FE mở form tạo CR.
 * Chat hỏi đáp thường vẫn đi tiếp.
 */

import { Project } from "../project/project.model.js"
import { Mode1Error } from "./mode1.errors.js"

export interface CrPrefill {
  title: string
  description: string
}

export const isMode1Project = async (projectId: string): Promise<boolean> =>
  (await Project.findById(projectId).select("mode").lean())?.mode === "import"

/** Nội dung điền sẵn cho form CR từ câu lệnh sửa (hoặc mô tả op). */
export const prefillFrom = (instruction: string | undefined, fallback = "Sửa tài liệu"): CrPrefill => {
  const text = (instruction ?? "").trim()
  if (!text) return { title: fallback, description: fallback }
  const firstLine = text.split(/\r?\n/)[0]
  return { title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine, description: text }
}

export const changeRequiresCr = (prefill: CrPrefill): Mode1Error =>
  new Mode1Error("CHANGE_REQUIRES_CR", "Tài liệu đã có baseline — mọi sửa phải qua change request", { prefill })

export const assertChangesAllowed = async (projectId: string, prefill: CrPrefill): Promise<void> => {
  if (await isMode1Project(projectId)) throw changeRequiresCr(prefill)
}
