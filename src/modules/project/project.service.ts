import { Project, IProject, ProjectStatus } from "./project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChatSession } from "./chat-session.model.js"
import { ProjectDocument } from "./project-document.model.js"
import { Section } from "../specification/section.model.js"

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
  return project
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
  hard: boolean = false,
  status: ProjectStatus = "inactive"
): Promise<any> => {
  if (hard) {
    const project = await Project.findOneAndDelete({ _id: projectId, userId })
    if (!project) {
      throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    }
    // Clean up all related models to prevent orphaned records in MongoDB
    await ChatSession.deleteMany({ projectId })
    await ProjectDocument.deleteMany({ projectId })
    await Section.deleteMany({ projectId })
    return { _id: projectId, status: "deleted" }
  } else {
    const targetStatus: ProjectStatus = status === "archived" ? "archived" : "inactive"
    const project = await Project.findOneAndUpdate(
      { _id: projectId, userId },
      { status: targetStatus },
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
