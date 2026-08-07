import { Project, IProject } from "./project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"

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

export const getProjects = async (userId: string): Promise<IProject[]> => {
  return await Project.find({ userId }).sort({ createdAt: -1 })
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
