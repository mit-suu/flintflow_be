/**
 * Chặn sửa ngoài change request ở project mode 1 (BR-03). FLF-171, plan §6 2G; mode 1 v3 (bám BPMN 2026-09-22):
 * Flow 1 kết thúc ở gap report (1.13) hoặc đi sang 3.1 — **import xong (baseline v0 `imported`) là mọi sửa phải qua
 * change request**. Không còn giai đoạn "sửa tự do tới baseline v1" của v2.
 * - Sửa trực tiếp (`/changes`, `/reconcile`, `/undo`, lệnh sửa trong chat) ⇒ `409 CHANGE_REQUIRES_CR` kèm nội dung
 *   điền sẵn. **Không tự tạo CR**: 3.1 là việc của BA (nguồn + người yêu cầu bắt buộc), FE mở form điền sẵn.
 * - Mode 1 không chạy step / gate / bật-tắt step, không ký baseline v1, không waive cờ (Flow 1 không có các nút đó;
 *   khoá duy nhất sau v0 là release — Flow 6).
 * Đồng thời đăng ký hồ sơ luật mode 1 làm mặc định cho mọi lượt tính lại cờ của project mode 1.
 */

import type { CrSourceKind } from "../change-request/change-request.constants.js"
import { Project } from "../project/project.model.js"
import * as flagsService from "../spine/flags.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Mode1Error, type Mode1ErrorCode } from "./mode1.errors.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"

export interface CrPrefill {
  title: string
  description: string
  /** Nguồn gợi ý cho form 3.1 (vd lệnh trong chat ⇒ yêu cầu miệng, `ref: chat:<id>`). BA vẫn sửa được. */
  source?: { kind: CrSourceKind; ref: string | null }
}

export const isMode1Project = async (projectId: string): Promise<boolean> =>
  (await Project.findById(projectId).select("mode").lean())?.mode === "import"

flagsService.setRuleProfileResolver(async (projectId) => ((await isMode1Project(projectId)) ? MODE1_RULE_PROFILE : undefined))

/** Project mode 1 đã import xong (có baseline v0 trở lên) — từ đây mọi sửa phải qua CR. */
export const changesRequireCr = async (projectId: string): Promise<boolean> => {
  if (!(await isMode1Project(projectId))) return false
  const spine = await spineRepository.get(projectId)
  return (spine?.baselines.length ?? 0) > 0
}

/** Nội dung điền sẵn cho form CR từ câu lệnh sửa (hoặc mô tả op). */
export const prefillFrom = (instruction: string | undefined, fallback = "Sửa tài liệu", source?: CrPrefill["source"]): CrPrefill => {
  const text = (instruction ?? "").trim()
  const base = !text
    ? { title: fallback, description: fallback }
    : (() => {
        const firstLine = text.split(/\r?\n/)[0]
        return { title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine, description: text }
      })()
  return source ? { ...base, source } : base
}

export const changeRequiresCr = (prefill: CrPrefill): Mode1Error =>
  new Mode1Error("CHANGE_REQUIRES_CR", "Tài liệu đã import — mọi sửa phải qua change request", { prefill })

export const assertChangesAllowed = async (projectId: string, prefill: CrPrefill): Promise<void> => {
  if (await changesRequireCr(projectId)) throw changeRequiresCr(prefill)
}

/** Việc của workspace mode 2 không có trong Flow 1. */
export type Mode1Forbidden = "steps" | "signoff" | "waive"

const FORBIDDEN: Record<Mode1Forbidden, { code: Mode1ErrorCode; message: string }> = {
  steps: { code: "MODE1_NO_STEPS", message: "Mode 1 không chạy step — sửa tài liệu qua change request" },
  signoff: { code: "MODE1_NO_SIGNOFF", message: "Mode 1 không ký baseline v1 — release khi hết cờ đỏ" },
  waive: { code: "MODE1_NO_WAIVE", message: "Mode 1 không waive cờ — xử lý cờ qua change request" }
}

/**
 * Chặn mọi lúc với project mode 1 (không phụ thuộc đã import xong hay chưa — Flow 1 không có các nút này).
 * Nhận `mode` của project mà controller đã nạp khi kiểm quyền — không truy vấn thêm.
 */
export const assertNotMode1 = (mode: string | null | undefined, what: Mode1Forbidden): void => {
  if (mode === "import") throw new Mode1Error(FORBIDDEN[what].code, FORBIDDEN[what].message)
}
