import { ApiError } from "../../shared/utils/api-error.js"
import { ProjectDocument } from "./project-document.model.js"
import { getProjectById } from "./project.service.js"
import { uploadFileToCloudinary } from "../../shared/utils/cloudinary.js"

export const uploadProjectDocument = async (
  userId: string,
  projectId: string,
  file: Express.Multer.File
): Promise<any> => {
  if (!file) {
    throw new ApiError(400, "A file is required", "FILE_REQUIRED")
  }

  const project = await getProjectById(projectId, userId)

  const allowedMimeTypes = new Set([
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword"
  ])

  const allowedExtensions = new Set([".pdf", ".txt", ".md", ".docx", ".doc"])
  const originalName = file.originalname || ""
  const extension = originalName.slice(originalName.lastIndexOf("."))?.toLowerCase() || ""

  if (!allowedMimeTypes.has(file.mimetype) && !allowedExtensions.has(extension)) {
    throw new ApiError(400, "Only PDF, DOCX, MD, TXT files are supported", "UNSUPPORTED_FILE_TYPE")
  }

  const uploadResult = await uploadFileToCloudinary(file, {
    folder: `flintflow/projects/${project._id}`
  })

  const document = await ProjectDocument.create({
    projectId: project._id,
    uploadedBy: userId,
    fileName: uploadResult.public_id,
    originalName,
    mimeType: file.mimetype,
    size: file.size,
    cloudinaryPublicId: uploadResult.public_id,
    url: uploadResult.secure_url,
    extension
  })

  return document
}

export const getProjectDocuments = async (userId: string, projectId: string): Promise<any[]> => {
  await getProjectById(projectId, userId)

  return await ProjectDocument.find({ projectId }).sort({ createdAt: -1 })
}

export const deleteProjectDocument = async (userId: string, projectId: string, documentId: string): Promise<void> => {
  await getProjectById(projectId, userId)

  const document = await ProjectDocument.findOne({ _id: documentId, projectId })
  if (!document) {
    throw new ApiError(404, "Document not found", "DOCUMENT_NOT_FOUND")
  }

  await ProjectDocument.deleteOne({ _id: documentId, projectId })
}
