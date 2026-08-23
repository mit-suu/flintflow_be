/**
 * Verification Context Service (Nền tảng Giai đoạn 1)
 *
 * Nhiệm vụ trong Giai đoạn 1:
 * - Tạo tầng service/controller/route cho VerificationContext (trước đây chỉ có model rỗng).
 * - Tính toán chỉ số mức độ sẵn sàng (Readiness Score & Status) dựa trên state machine và progressPercent của Task B/C (chưa gọi AI phân tích chuyên sâu).
 * - Giữ các trường AI (conflicts, hiddenAssumptions, missingInfo, ambiguities, followUpQuestions) ở dạng mảng rỗng [], sẵn sàng để Giai đoạn 2 bổ sung logic AI phân tích (Group 6 UC 6.4, 6.5).
 */

import mongoose from "mongoose"
import { VerificationContext, IVerificationContext, ReadinessStatus } from "./verification-context.model.js"
import { Project } from "../project/project.model.js"
import { calculateProgress, getProjectProgressBreakdown } from "../specification/phase-gate.service.js"
import { ApiError } from "../../shared/utils/api-error.js"

export interface BasicReadinessResult {
  verificationContext: IVerificationContext
  summary: {
    projectId: string
    currentPhase: number
    progressPercent: number
    readinessScore: number
    readinessStatus: ReadinessStatus
    lastComputedAt: Date
  }
}

/**
 * Xác định trạng thái ReadinessStatus dựa trên tiến độ hoàn thành các section bắt buộc.
 */
const determineReadinessStatus = (progressPercent: number): ReadinessStatus => {
  if (progressPercent >= 100) {
    return "READY_TO_BUILD"
  }
  if (progressPercent === 0) {
    return "BLOCKED"
  }
  return "NEEDS_CLARIFICATION"
}

/**
 * Tính toán mức độ sẵn sàng cơ bản dựa trên tiến độ hoàn thành của dự án (Task D).
 * Cập nhật hoặc khởi tạo bản ghi trong collection VerificationContext.
 */
export const computeBasicReadiness = async (
  projectId: string
): Promise<BasicReadinessResult> => {
  const project = await Project.findById(projectId).select("currentPhase progressPercent name").lean()
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  // Tính lại tiến độ thật từ database
  const progressPercent = await calculateProgress(projectId)
  const readinessScore = progressPercent
  const readinessStatus = determineReadinessStatus(progressPercent)
  const now = new Date()

  // Upsert vào collection VerificationContext
  const verificationContext = await VerificationContext.findOneAndUpdate(
    { projectId: new mongoose.Types.ObjectId(projectId) },
    {
      $set: {
        readinessScore,
        readinessStatus,
        lastComputedAt: now
      },
      $setOnInsert: {
        projectId: new mongoose.Types.ObjectId(projectId),
        hiddenAssumptions: [],
        missingInfo: [],
        conflicts: [],
        ambiguities: [],
        followUpQuestions: []
      }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  )

  return {
    verificationContext,
    summary: {
      projectId,
      currentPhase: project.currentPhase || 2,
      progressPercent,
      readinessScore,
      readinessStatus,
      lastComputedAt: now
    }
  }
}

/**
 * Lấy VerificationContext của một dự án.
 * Nếu chưa từng tính toán, tự động gọi computeBasicReadiness để khởi tạo.
 */
export const getVerificationContext = async (
  projectId: string
): Promise<IVerificationContext> => {
  const context = await VerificationContext.findOne({
    projectId: new mongoose.Types.ObjectId(projectId)
  })

  if (!context) {
    const result = await computeBasicReadiness(projectId)
    return result.verificationContext
  }

  return context
}

