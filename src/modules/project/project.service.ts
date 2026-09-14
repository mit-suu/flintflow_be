import mongoose from "mongoose"
import { Project, IProject, ProjectStatus } from "./project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChatSession } from "./chat-session.model.js"
import { ProjectDocument } from "./project-document.model.js"
import { Section } from "../specification/section.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Spine } from "../spine/spine.model.js"
import { Change } from "../spine/change.model.js"
import { Baseline } from "../spine/baseline.model.js"
import { Usage } from "../spine/usage.model.js"

export const createProject = async (
  userId: string,
  name: string,
  domain?: string
): Promise<IProject> => {
  const project = await Project.create({
    userId,
    name,
    domain: domain || null,
    status: "active",
    currentStep: "vision_problem",
    progressPercent: 0
  })
  await spineRepository.getOrCreate(project.id, { name, domain: domain || null })
  return project
}

/**
 * List projects by status (legacy helper — wraps getProjects).
 */
export const listProjects = async (userId: string, status: ProjectStatus = "active"): Promise<IProject[]> => {
  return Project.find({ userId: new mongoose.Types.ObjectId(userId), status }).sort({ updatedAt: -1 })
}

export const getProjects = async (userId: string, status?: string): Promise<IProject[]> => {
  const filter: any = { userId }
  if (status) {
    filter.status = status
  }
  return await Project.find(filter).sort({ createdAt: -1 })
}

export const getProjectById = async (
  projectId: string,
  userId: string
): Promise<IProject> => {
  const project = await Project.findOne({ _id: projectId, userId })
  if (!project) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  return project
}

export const deleteProject = async (
  projectId: string,
  userId: string,
  hard: boolean = false
): Promise<any> => {
  if (hard) {
    const project = await Project.findOneAndDelete({ _id: projectId, userId })
    if (!project) {
      throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    }
    // Dọn mọi dữ liệu thuộc project, gồm Spine và các collection tách riêng của nó
    // (changes, baselines chứa snapshot lớn, usages) để không để lại document mồ côi
    await Promise.all([
      ChatSession.deleteMany({ projectId }),
      ProjectDocument.deleteMany({ projectId }),
      Section.deleteMany({ projectId }),
      Spine.deleteMany({ projectId }),
      Change.deleteMany({ projectId }),
      Baseline.deleteMany({ projectId }),
      Usage.deleteMany({ projectId })
    ])
    return { _id: projectId, status: "deleted" }
  } else {
    const project = await Project.findOneAndUpdate(
      { _id: projectId, userId },
      { status: "archived" },
      { new: true }
    )
    if (!project) {
      throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    }
    return project
  }
}

export const updateProjectName = async (
  projectId: string,
  userId: string,
  name: string
): Promise<IProject> => {
  const project = await Project.findOneAndUpdate(
    { _id: projectId, userId },
    { name },
    { new: true }
  )
  if (!project) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  return project
}

/**
 * Rename a project (legacy — delegates to updateProjectName).
 */
export const renameProject = async (userId: string, id: string, name: string): Promise<IProject> => {
  return updateProjectName(id, userId, name)
}

/**
 * Archive a project (legacy — delegates to deleteProject with hard=false).
 */
export const archiveProject = async (userId: string, id: string): Promise<void> => {
  await deleteProject(id, userId, false)
}
