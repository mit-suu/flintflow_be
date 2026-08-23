/**
 * Phase Gate & State Machine Service
 *
 * Quản lý cơ chế Phase Gate theo chuẩn UC 3.1→3.4, 4.1→4.5, 5.1→5.5:
 * - Chỉ cho phép làm việc / generate / accept section của Phase N+1 khi toàn bộ
 *   các section có mappedToTemplate = true của Phase N đã ở trạng thái "accepted".
 * - Khi toàn bộ section bắt buộc của Phase N đã accepted, tự động nâng currentPhase
 *   của Project lên N+1.
 * - Section thuộc phase đã hoàn thành (phase < currentPhase) và đã accepted
 *   sẽ bị khoá (không được sửa trực tiếp, phải qua cơ chế Change Request ở giai đoạn sau).
 */

import mongoose from "mongoose"
import { Project } from "../project/project.model.js"
import { Section, SectionType } from "./section.model.js"
import {
  SECTION_METADATA,
  getMappedSectionsByPhase,
  getAllMappedSections,
  WorkspacePhase
} from "../../shared/constants/section-types.js"
import { ApiError } from "../../shared/utils/api-error.js"

export interface CanAccessPhaseResult {
  allowed: boolean
  currentPhase: 2 | 3 | 4
  targetPhase: 2 | 3 | 4
  missingSections?: string[]
  reason?: string
}

export interface PhaseProgressionResult {
  advanced: boolean
  oldPhase: number
  newPhase: number
  newWorkspacePhase: WorkspacePhase
  unacceptedSections: string[]
  progressPercent: number
}

/**
 * Kiểm tra xem người dùng có quyền truy cập / thao tác trên một Phase cụ thể không.
 *
 * @param projectId   - ID của dự án
 * @param targetPhase - Phase mục tiêu (2, 3, hoặc 4)
 */
export const canAccessPhase = async (
  projectId: string,
  targetPhase: 2 | 3 | 4
): Promise<CanAccessPhaseResult> => {
  const project = await Project.findById(projectId).select("currentPhase").lean()
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  const currentPhase = (project.currentPhase || 2) as 2 | 3 | 4

  // Phase hiện tại hoặc các phase trước đó đã được unlock từ trước
  if (targetPhase <= currentPhase) {
    return {
      allowed: true,
      currentPhase,
      targetPhase
    }
  }

  // Cố gắng nhảy cóc hơn 1 phase (ví dụ từ Phase 2 nhảy sang Phase 4)
  if (targetPhase > currentPhase + 1) {
    return {
      allowed: false,
      currentPhase,
      targetPhase,
      reason: `Không thể truy cập Phase ${targetPhase} khi chưa hoàn thành Phase ${currentPhase} và Phase ${currentPhase + 1}.`
    }
  }

  // targetPhase === currentPhase + 1: Kiểm tra toàn bộ section mappedToTemplate: true của currentPhase đã accepted chưa
  const requiredTypes = getMappedSectionsByPhase(currentPhase)
  const acceptedSections = await Section.find({
    projectId: new mongoose.Types.ObjectId(projectId),
    type: { $in: requiredTypes },
    status: "accepted"
  })
    .select("type")
    .lean()

  const acceptedSet = new Set(acceptedSections.map((s) => s.type))
  const missingSections = requiredTypes.filter((t) => !acceptedSet.has(t))

  if (missingSections.length === 0) {
    return {
      allowed: true,
      currentPhase,
      targetPhase
    }
  }

  const missingLabels = missingSections.map(
    (t) => `"${SECTION_METADATA[t]?.label || t}"`
  )

  return {
    allowed: false,
    currentPhase,
    targetPhase,
    missingSections,
    reason: `Phase ${targetPhase} đang bị khóa (Phase Gate Locked). Bạn cần nghiệm thu (accept) toàn bộ ${requiredTypes.length} section của Phase ${currentPhase}. Còn thiếu: ${missingLabels.join(", ")}.`
  }
}

/**
 * Kiểm tra xem một Section có được phép chỉnh sửa trực tiếp không.
 * Section thuộc phase trước đó (phase < currentPhase) và đã accepted sẽ bị khoá baseline.
 */
export const canModifySection = async (
  projectId: string,
  sectionType: SectionType
): Promise<{ allowed: boolean; reason?: string }> => {
  const meta = SECTION_METADATA[sectionType]
  if (!meta) return { allowed: true }

  const project = await Project.findById(projectId).select("currentPhase").lean()
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  const currentPhase = (project.currentPhase || 2) as 2 | 3 | 4

  // Nếu section thuộc phase đã qua và đã accepted -> khoá baseline
  if (meta.phase < currentPhase) {
    const section = await Section.findOne({ projectId, type: sectionType }).select("status").lean()
    if (section && section.status === "accepted") {
      return {
        allowed: false,
        reason: `Section "${meta.label}" thuộc Phase ${meta.phase} đã được nghiệm thu và khóa baseline. Không thể chỉnh sửa trực tiếp (cần quy trình Change Request).`
      }
    }
  }

  return { allowed: true }
}

/**
 * Tính toán tỷ lệ phần trăm tiến độ (Progress Percent) của dự án.
 * Dựa trên số lượng section có mappedToTemplate = true đã được accepted / tổng số (22 loại).
 */
export const calculateProgress = async (projectId: string): Promise<number> => {
  const allMapped = getAllMappedSections()
  if (allMapped.length === 0) return 0

  const acceptedCount = await Section.countDocuments({
    projectId: new mongoose.Types.ObjectId(projectId),
    type: { $in: allMapped },
    status: "accepted"
  })

  // Làm tròn xuống
  return Math.floor((acceptedCount / allMapped.length) * 100)
}

/**
 * Kiểm tra điều kiện và tự động nâng currentPhase của dự án nếu toàn bộ
 * section bắt buộc của phase hiện tại đã được accepted.
 */
export const checkAndAdvancePhase = async (
  projectId: string
): Promise<PhaseProgressionResult> => {
  const project = await Project.findById(projectId)
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  const oldPhase = (project.currentPhase || 2) as 2 | 3 | 4
  const progressPercent = await calculateProgress(projectId)
  project.progressPercent = progressPercent

  const phaseToWorkspacePhase: Record<number, WorkspacePhase> = {
    2: "product_overview",
    3: "functional_spec",
    4: "nfr_appendix"
  }

  // Nếu đã ở Phase 4 thì không tăng thêm nữa
  if (oldPhase >= 4) {
    await project.save()
    return {
      advanced: false,
      oldPhase,
      newPhase: oldPhase,
      newWorkspacePhase: (project.workspacePhase as WorkspacePhase) || "nfr_appendix",
      unacceptedSections: [],
      progressPercent
    }
  }

  // Kiểm tra các section bắt buộc của phase hiện tại
  const requiredTypes = getMappedSectionsByPhase(oldPhase)
  const acceptedSections = await Section.find({
    projectId: new mongoose.Types.ObjectId(projectId),
    type: { $in: requiredTypes },
    status: "accepted"
  })
    .select("type")
    .lean()

  const acceptedSet = new Set(acceptedSections.map((s) => s.type))
  const unaccepted = requiredTypes.filter((t) => !acceptedSet.has(t))

  if (unaccepted.length === 0) {
    const newPhase = (oldPhase + 1) as 2 | 3 | 4
    project.currentPhase = newPhase
    project.currentStep = `phase_${newPhase}`
    project.workspacePhase = phaseToWorkspacePhase[newPhase] || "product_overview"
    await project.save()

    console.log(
      `[PhaseGate] 🚀 Project "${project.name}" (${projectId}) advanced from Phase ${oldPhase} → Phase ${newPhase} (Workspace: ${project.workspacePhase}, Progress: ${progressPercent}%)`
    )

    return {
      advanced: true,
      oldPhase,
      newPhase,
      newWorkspacePhase: project.workspacePhase as WorkspacePhase,
      unacceptedSections: [],
      progressPercent
    }
  }

  await project.save()
  return {
    advanced: false,
    oldPhase,
    newPhase: oldPhase,
    newWorkspacePhase: (project.workspacePhase as WorkspacePhase) || "product_overview",
    unacceptedSections: unaccepted,
    progressPercent
  }
}

export interface PhaseSectionStatusItem {
  type: SectionType
  label: string
  order: number
  mappedToTemplate: boolean
  status: "draft" | "accepted" | "edited_manually" | "regenerated" | "not_started"
  hasContent: boolean
  updatedAt?: Date
}

export interface PhaseProgressSummary {
  phase: 2 | 3 | 4
  name: string
  completed: number
  total: number
  percent: number
  isUnlocked: boolean
  isCompleted: boolean
  sections: PhaseSectionStatusItem[]
}

export interface ProjectProgressBreakdown {
  projectId: string
  overallProgress: number
  totalMappedSections: number
  totalAcceptedMappedSections: number
  currentPhase: 2 | 3 | 4
  workspacePhase: WorkspacePhase
  phases: {
    phase2: PhaseProgressSummary
    phase3: PhaseProgressSummary
    phase4: PhaseProgressSummary
  }
}

/**
 * Trả về chi tiết tiến độ theo từng Phase và từng Section cho một dự án.
 * Phục vụ UC 7.1 (Detailed Section Status) & UC 7.2 (Overall Progress).
 */
export const getProjectProgressBreakdown = async (
  projectId: string
): Promise<ProjectProgressBreakdown> => {
  const project = await Project.findById(projectId).select("currentPhase workspacePhase progressPercent").lean()
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  const currentPhase = (project.currentPhase || 2) as 2 | 3 | 4
  const workspacePhase = (project.workspacePhase as WorkspacePhase) || "discovery"

  // Lấy toàn bộ sections đã có trong DB của project
  const existingSections = await Section.find({ projectId }).lean()
  const sectionMap = new Map(existingSections.map((s) => [s.type, s]))

  // Helper để build summary cho 1 phase
  const buildPhaseSummary = (
    phaseNum: 2 | 3 | 4,
    phaseName: string
  ): PhaseProgressSummary => {
    const types = (Object.keys(SECTION_METADATA) as SectionType[]).filter(
      (t) => SECTION_METADATA[t].phase === phaseNum
    )

    const sectionItems: PhaseSectionStatusItem[] = types.map((type) => {
      const meta = SECTION_METADATA[type]
      const existing = sectionMap.get(type)

      return {
        type,
        label: meta.label,
        order: meta.order,
        mappedToTemplate: meta.mappedToTemplate,
        status: existing ? existing.status : "not_started",
        hasContent: Boolean(existing?.content),
        updatedAt: existing?.updatedAt
      }
    })

    const mappedTypes = sectionItems.filter((item) => item.mappedToTemplate)
    const completedMapped = mappedTypes.filter((item) => item.status === "accepted").length
    const totalMapped = mappedTypes.length
    const percent = totalMapped > 0 ? Math.floor((completedMapped / totalMapped) * 100) : 0

    return {
      phase: phaseNum,
      name: phaseName,
      completed: completedMapped,
      total: totalMapped,
      percent,
      isUnlocked: currentPhase >= phaseNum,
      isCompleted: completedMapped === totalMapped && totalMapped > 0,
      sections: sectionItems
    }
  }

  const phase2 = buildPhaseSummary(2, "Phase 2: Discovery & Foundation")
  const phase3 = buildPhaseSummary(3, "Phase 3: Core Functional Specifications")
  const phase4 = buildPhaseSummary(4, "Phase 4: Non-Functional & Release")

  const allMapped = getAllMappedSections()
  const totalAcceptedMapped = existingSections.filter(
    (s) => s.status === "accepted" && SECTION_METADATA[s.type]?.mappedToTemplate
  ).length

  const overallProgress = allMapped.length > 0 ? Math.floor((totalAcceptedMapped / allMapped.length) * 100) : 0

  return {
    projectId,
    overallProgress,
    totalMappedSections: allMapped.length,
    totalAcceptedMappedSections: totalAcceptedMapped,
    currentPhase,
    workspacePhase,
    phases: {
      phase2,
      phase3,
      phase4
    }
  }
}

