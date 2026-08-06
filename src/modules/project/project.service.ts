import mongoose from "mongoose"
import { Project, IProject, ProjectStatus } from "./project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const listProjects = async (userId: string, status: ProjectStatus = "active"): Promise<IProject[]> => {
  return Project.find({ userId: new mongoose.Types.ObjectId(userId), status }).sort({ updatedAt: -1 })
}

export const createProject = async (userId: string, name: string): Promise<IProject> => {
  return Project.create({ userId: new mongoose.Types.ObjectId(userId), name })
}

export const renameProject = async (userId: string, id: string, name: string): Promise<IProject> => {
  const project = await Project.findById(id)
  if (!project) {
    throw new ApiError(404, "Project không tồn tại", "PROJECT_NOT_FOUND")
  }
  if (project.userId.toString() !== userId) {
    throw new ApiError(403, "Không có quyền thực hiện hành động này", "FORBIDDEN")
  }
  project.name = name
  await project.save()
  return project
}

export const archiveProject = async (userId: string, id: string): Promise<void> => {
  const project = await Project.findById(id)
  if (!project) {
    throw new ApiError(404, "Project không tồn tại", "PROJECT_NOT_FOUND")
  }
  if (project.userId.toString() !== userId) {
    throw new ApiError(403, "Không có quyền thực hiện hành động này", "FORBIDDEN")
  }
  project.status = "archived"
  await project.save()
}
