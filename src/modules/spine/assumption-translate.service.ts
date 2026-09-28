/**
 * assumption-translate.service.ts
 * ─────────────────────────────────────────────────────────────────
 * "Sửa" một giả định (FLF-221): user gõ lại câu giả định bằng ngôn ngữ của mình (`statement_vi`) ở cổng duyệt,
 * AssumptionSweep hoặc Brief panel. SRS in `statement` (tiếng Anh), nên sửa bản của user mà không dịch thì hai bản
 * lệch nhau. Một lượt gọi model ngắn (`translate`, tính credit như mọi lượt gọi khác qua `executeAiAction`) dịch
 * sang tiếng Anh, rồi ghi CẢ HAI trong một transaction. Model lỗi ⇒ không ghi gì, lỗi đi ra để FE giữ ô sửa.
 *
 * HTTP: `PATCH /projects/:id/assumptions/:assumptionId` (`docs/api/pipeline-contract.md`).
 */

import { applyTransaction } from "./op-engine.js"
import * as repository from "./spine.repository.js"
import type { SpineRecord } from "./spine.types.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { TranslateOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const ASSUMPTION_NOT_FOUND = "ASSUMPTION_NOT_FOUND"

export type TranslateExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<TranslateOutput>>

export const defaultTranslateExecutor: TranslateExecutor = (input, projectId, userId) =>
  executeAiAction<TranslateOutput>(ActionType.TRANSLATE, input, projectId, userId)

export interface TranslateAssumptionInput {
  statement_vi: string
  base_version: number
}

export interface TranslateAssumptionResult {
  spine_version: number
  spine: SpineRecord
}

export const translateAssumption = async (
  projectId: string,
  assumptionId: string,
  userId: string,
  input: TranslateAssumptionInput,
  executor: TranslateExecutor = defaultTranslateExecutor
): Promise<TranslateAssumptionResult> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  // Kiểm version TRƯỚC khi gọi model: lệch thì khỏi tốn credit cho một bản dịch sẽ không ghi được.
  if (record.spine_version !== input.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
  const assumption = record.assumptions.find((a) => a.id === assumptionId)
  if (!assumption) throw new ApiError(404, `Không có giả định ${assumptionId}`, ASSUMPTION_NOT_FOUND)

  const result = await executor(
    { promptVariables: { path: assumption.path, previous_statement: assumption.statement, statement_vi: input.statement_vi } },
    projectId,
    userId
  )

  const applied = await applyTransaction(projectId, {
    base_version: input.base_version,
    ops: [
      { op: "set", path: `assumptions[id=${assumptionId}].statement`, value: result.data.statement.trim() },
      { op: "set", path: `assumptions[id=${assumptionId}].statement_vi`, value: input.statement_vi }
    ],
    by: userId,
    step_id: null,
    reason: `Sửa giả định ${assumptionId}`
  })
  return { spine_version: applied.spine_version, spine: applied.spine }
}
