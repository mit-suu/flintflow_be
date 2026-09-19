/**
 * Chặn sửa ngoài change request ở project mode 1 (BR-03). FLF-171, plan §6 2G; đổi ở mode 1 v2 (D3, FLF-183):
 * trước baseline v1 (sign-off) người dùng sửa tự do như workspace mode 2 — `/changes`, `/undo`, chat sửa chạy bình
 * thường. Chỉ khi project đã có baseline v1 (`generated`) hoặc đã release thì sửa trực tiếp trả `409 CHANGE_REQUIRES_CR`
 * kèm nội dung điền sẵn để mở CR. Baseline `imported` (v0) chỉ để đối chiếu gap, không khoá.
 * Đồng thời đăng ký hồ sơ luật mode 1 làm mặc định cho mọi lượt tính lại cờ của project mode 1.
 */

import { Project } from "../project/project.model.js"
import * as flagsService from "../spine/flags.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Mode1Error } from "./mode1.errors.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"

export interface CrPrefill {
  title: string
  description: string
}

export const isMode1Project = async (projectId: string): Promise<boolean> =>
  (await Project.findById(projectId).select("mode").lean())?.mode === "import"

flagsService.setRuleProfileResolver(async (projectId) => ((await isMode1Project(projectId)) ? MODE1_RULE_PROFILE : undefined))

/** Project mode 1 đã có baseline v1 (sign-off) hoặc release — từ đây mọi sửa phải qua CR (D3). */
export const changesRequireCr = async (projectId: string): Promise<boolean> => {
  if (!(await isMode1Project(projectId))) return false
  const spine = await spineRepository.get(projectId)
  return !!spine?.baselines.some((b) => b.type !== "imported")
}

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
  if (await changesRequireCr(projectId)) throw changeRequiresCr(prefill)
}
