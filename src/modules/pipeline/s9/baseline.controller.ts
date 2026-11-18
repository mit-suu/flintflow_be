/**
 * baseline.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * Endpoint 19, 20, 32 và 33 của `docs/api/pipeline-contract.md`:
 *   POST /projects/:id/baseline         Lead duyệt và ký baseline (S-9.5, UC-46)
 *   GET  /projects/:id/baselines        danh sách mốc đã ký
 *   POST /projects/:id/baseline/submit  Analyst gửi Lead duyệt (UC-45)
 *   POST /projects/:id/baseline/reject  Lead từ chối kèm lý do (UC-46 luồng thay thế)
 *
 * Bản sạch của một baseline đọc qua endpoint 16 đã có sẵn:
 * `GET /projects/:id/document?source=baseline&baseline_id=<id>` (T15) — không thêm alias mới để khỏi
 * mở endpoint ngoài hợp đồng.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import * as baselineService from "./baseline.service.js"
import * as approvalService from "./baseline-approval.service.js"
import { baselineRejectRequestSchema, baselineRequestSchema, baselineSubmitRequestSchema } from "../pipeline.dto.js"
import { getProjectById } from "../../project/project.service.js"
import { requireOrgId } from "../../../shared/auth/org-request.js"
import { sendError, sendSuccess } from "../../../shared/types/api-response.js"
import { catchAsync } from "../../../shared/utils/catch-async.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { validationError } from "../../../shared/utils/validation-message.js"
import { convertAfterSignOff } from "../../import/convert-from-fpt.service.js"
import { assertNotMode1 } from "../../import/mode1-guard.js"

interface Authorized {
  projectId: string
  projectName: string
  orgId: string
  userId: string
  mode: string
}

/** Kiểm quyền sở hữu trước khi đọc body; project không thuộc user trả 404, không 403 (hợp đồng §0). */
const authorize = async (req: Request): Promise<Authorized> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  const orgId = requireOrgId(req)
  const project = await getProjectById(projectId, orgId)
  return { projectId, projectName: project.name, orgId, userId, mode: project.mode ?? "fpt" }
}

/** `meta.flags[]` của 422 BASELINE_BLOCKED — chung cho lượt nộp và lượt duyệt. */
const sendBlocked = (res: Response, err: baselineService.BaselineBlockedError) =>
  sendError(res, err.statusCode, err.code, err.message, {
    flags: err.flags.map(({ id, rule_id, section_id, target_id, message, remediation_step }) => ({
      id,
      rule_id,
      section_id,
      target_id,
      message,
      remediation_step
    }))
  })

export const createBaseline = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  assertNotMode1(auth.mode, "signoff") // mode 1 v3: khoá duy nhất sau v0 là release (Flow 6)
  const parsed = baselineRequestSchema.safeParse(req.body)
  if (!parsed.success) throw validationError(parsed.error)

  try {
    const result = await baselineService.signOff(auth.projectId, auth.userId, { base_version: parsed.data.base_version })
    // FLF-318: dự án tạo SRS ⇒ chuyển sang mode 1 (CR); lỗi không làm hỏng lượt ký — chạy lại khi mở dự án
    const converted = await convertAfterSignOff(auth.projectId, auth.userId)
    return sendSuccess(res, 201, result.baseline, {
      spine_version: result.spine_version,
      project_mode: converted ? "import" : auth.mode,
      waived: result.waived.map(({ id, rule_id, section_id, waive_reason }) => ({ id, rule_id, section_id, waive_reason }))
    })
  } catch (err) {
    if (err instanceof baselineService.BaselineBlockedError) return sendBlocked(res, err)
    throw err
  }
})

export const listBaselines = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  return sendSuccess(res, 200, await baselineService.listBaselines(auth.projectId))
})

/** UC-45 — Analyst gửi SRS cho Lead duyệt. Chưa khoá baseline, chỉ đặt trạng thái chờ duyệt. */
export const submitBaseline = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  assertNotMode1(auth.mode, "signoff")
  const parsed = baselineSubmitRequestSchema.safeParse(req.body)
  if (!parsed.success) throw validationError(parsed.error)

  try {
    const result = await approvalService.submitForApproval(auth, parsed.data.base_version)
    return sendSuccess(res, 200, result.submission, { spine_version: result.spine_version })
  } catch (err) {
    if (err instanceof baselineService.BaselineBlockedError) return sendBlocked(res, err)
    if (err instanceof approvalService.RejectionCommentsOpenError) {
      return sendError(res, err.statusCode, err.code, err.message, { comment_ids: err.commentIds })
    }
    throw err
  }
})

/** UC-46 luồng thay thế — Lead từ chối kèm lý do và các comment đã ghim vào nội dung. */
export const rejectBaseline = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  assertNotMode1(auth.mode, "signoff")
  const parsed = baselineRejectRequestSchema.safeParse(req.body)
  if (!parsed.success) throw validationError(parsed.error)

  const result = await approvalService.rejectSubmission(auth, parsed.data)
  return sendSuccess(res, 200, result.submission, { spine_version: result.spine_version })
})
