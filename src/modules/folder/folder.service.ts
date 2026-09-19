import mongoose from "mongoose"
import { Folder, type FolderColor, type IFolder } from "./folder.model.js"
import { Project } from "../project/project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { CreateFolderDTO, UpdateFolderDTO } from "./folder.validation.js"

/** Thư mục trả cho FE, kèm số dự án đang làm bên trong. */
export interface FolderItem {
  _id: string
  name: string
  color: FolderColor
  projectCount: number
  createdAt: Date
  updatedAt: Date
}

const notFound = () => new ApiError(404, "Folder not found or unauthorized", "FOLDER_NOT_FOUND")

const toItem = (folder: Pick<IFolder, "_id" | "name" | "color" | "createdAt" | "updatedAt">, projectCount: number): FolderItem => ({
  _id: String(folder._id),
  name: folder.name,
  color: folder.color,
  projectCount,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt
})

/** `folderId` không hợp lệ thì Mongoose ném CastError — quy về 404 như mọi truy vấn của user khác. */
const assertObjectId = (id: string) => {
  if (!mongoose.isValidObjectId(id)) throw notFound()
}

export const listFolders = async (userId: string): Promise<FolderItem[]> => {
  const [folders, counts] = await Promise.all([
    Folder.find({ userId }).sort({ createdAt: -1 }).lean(),
    Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { userId: new mongoose.Types.ObjectId(userId), status: "active", folderId: { $ne: null } } },
      { $group: { _id: "$folderId", count: { $sum: 1 } } }
    ])
  ])
  const countById = new Map(counts.map((c) => [String(c._id), c.count]))
  return folders.map((f) => toItem(f, countById.get(String(f._id)) ?? 0))
}

export const createFolder = async (userId: string, input: CreateFolderDTO): Promise<FolderItem> => {
  const folder = await Folder.create({ userId, name: input.name, color: input.color })
  return toItem(folder, 0)
}

export const updateFolder = async (userId: string, folderId: string, input: UpdateFolderDTO): Promise<FolderItem> => {
  assertObjectId(folderId)
  const folder = await Folder.findOneAndUpdate({ _id: folderId, userId }, input, { new: true })
  if (!folder) throw notFound()
  const projectCount = await Project.countDocuments({ userId, folderId, status: "active" })
  return toItem(folder, projectCount)
}

/**
 * Xoá thư mục; dự án bên trong được giữ và trở về ngoài thư mục. Nhả dự án TRƯỚC rồi mới xoá thư mục: lỗi giữa
 * chừng chỉ để lại thư mục rỗng, không bao giờ để dự án trỏ tới thư mục đã mất. (Lượt chuyển dự án chạy xen
 * giữa hai bước tự dọn nhờ `folderStillExists` ở `project.service.moveProjectToFolder`.)
 */
export const deleteFolder = async (userId: string, folderId: string): Promise<{ _id: string; releasedProjects: number }> => {
  await assertFolderOwned(userId, folderId)
  const released = await Project.updateMany({ userId, folderId }, { $set: { folderId: null } })
  const folder = await Folder.findOneAndDelete({ _id: folderId, userId })
  if (!folder) throw notFound()
  return { _id: folderId, releasedProjects: released.modifiedCount }
}

/** Ném 404 nếu thư mục không thuộc user — dùng khi tạo/chuyển dự án vào thư mục. */
export const assertFolderOwned = async (userId: string, folderId: string): Promise<void> => {
  assertObjectId(folderId)
  if (!(await Folder.exists({ _id: folderId, userId }))) throw notFound()
}

/**
 * Chuyển nhiều dự án (của chính user) vào thư mục. Id lạ / sai định dạng / của user khác bị bỏ qua — chỉ đếm
 * dự án thực sự được chuyển.
 */
export const addProjectsToFolder = async (userId: string, folderId: string, projectIds: string[]): Promise<{ moved: number }> => {
  await assertFolderOwned(userId, folderId)
  const ids = [...new Set(projectIds)].filter((id) => mongoose.isValidObjectId(id))
  if (ids.length === 0) return { moved: 0 }
  const result = await Project.updateMany({ _id: { $in: ids }, userId }, { $set: { folderId } })
  // Thư mục bị xoá chen giữa ⇒ gỡ các dự án vừa chuyển về ngoài thư mục (giống moveProjectToFolder)
  if (!(await folderStillExists(userId, folderId))) {
    await Project.updateMany({ _id: { $in: ids }, userId, folderId }, { $set: { folderId: null } })
    throw notFound()
  }
  return { moved: result.modifiedCount }
}

export const folderStillExists = async (userId: string, folderId: string): Promise<boolean> =>
  Boolean(await Folder.exists({ _id: folderId, userId }))
