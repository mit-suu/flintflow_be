import { createRequire } from "module"
import { ApiError } from "../../shared/utils/api-error.js"
import { ProjectDocument } from "./project-document.model.js"
import { getProjectById } from "./project.service.js"
import { uploadFileToCloudinary } from "../../shared/utils/cloudinary.js"
import { destroyDocumentAsset } from "./project-document.storage.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"

// pdf-parse và mammoth không có bundled TypeScript types nên dùng createRequire
// để import CommonJS module từ ESM context một cách an toàn.
const require = createRequire(import.meta.url)

/**
 * Ước lượng số token từ độ dài chuỗi.
 * Dùng tỷ lệ ~4 ký tự/token theo OpenAI estimation.
 * Không cần thư viện tokenizer chính xác ở giai đoạn này.
 */
const estimateTokenCount = (text: string): number => {
  return Math.ceil(text.length / 4)
}

/**
 * Parse nội dung text từ file đã upload.
 * Nhận Buffer từ Multer memoryStorage (đã xác nhận config là memoryStorage).
 * Trả về { text, tokenCount } hoặc throw Error nếu parse thất bại.
 */
const parseFileContent = async (
  buffer: Buffer,
  mimeType: string,
  extension: string
): Promise<{ text: string; tokenCount: number }> => {
  const ext = extension.toLowerCase()

  // PDF
  if (mimeType === "application/pdf" || ext === ".pdf") {
    const pdfParse = require("pdf-parse")
    const data = await pdfParse(buffer)
    const text = (data.text as string).trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  // DOCX / DOC (mammoth chỉ hỗ trợ .docx tốt; .doc là legacy binary)
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword" ||
    ext === ".docx" ||
    ext === ".doc"
  ) {
    const mammoth = require("mammoth")
    const result = await mammoth.extractRawText({ buffer })
    const text = (result.value as string).trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  // TXT / MD — đọc trực tiếp từ buffer
  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    ext === ".txt" ||
    ext === ".md"
  ) {
    const text = buffer.toString("utf-8").trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  throw new Error(`Unsupported file type for parsing: mimeType=${mimeType}, ext=${extension}`)
}

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

  // Step 1: Upload lên Cloudinary
  const uploadResult = await uploadFileToCloudinary(file, {
    folder: `flintflow/projects/${project._id}`
  })

  // Step 2: Lưu document record với parseStatus = "pending"
  const document = await ProjectDocument.create({
    projectId: project._id,
    uploadedBy: userId,
    fileName: uploadResult.public_id,
    originalName,
    mimeType: file.mimetype,
    size: file.size,
    cloudinaryPublicId: uploadResult.public_id,
    url: uploadResult.secure_url,
    extension,
    parseStatus: "pending",
    summaryStatus: "pending"
  })

  // Step 3: Parse nội dung text (chạy đồng bộ trong request, có try-catch riêng)
  // Lỗi parse KHÔNG làm fail toàn bộ request — document vẫn được trả về dù parse thất bại.
  try {
    const { text, tokenCount } = await parseFileContent(file.buffer, file.mimetype, extension)

    document.extractedText = text
    document.tokenCount = tokenCount
    document.parseStatus = "success"
    document.parseError = null

    await document.save()

    console.log(
      `[DocumentParser] Parsed "${originalName}" successfully: ${text.length} chars, ~${tokenCount} tokens`
    )
  } catch (parseErr: any) {
    document.parseStatus = "failed"
    document.parseError = parseErr?.message || "Unknown parse error"
    document.extractedText = null
    document.tokenCount = null

    await document.save()

    console.warn(
      `[DocumentParser] Failed to parse "${originalName}" (parseStatus=failed): ${parseErr?.message}`
    )
  }

  // Step 4: Summarize document bằng AI (Task 2b)
  // Chỉ chạy nếu parse thành công VÀ chưa từng summarize (summaryStatus !== "success")
  // Guard này đảm bảo không tính phí credit 2 lần cho cùng 1 document.
  if (document.parseStatus === "success" && document.summaryStatus !== "success") {
    try {
      const summarizeResult = await executeAiAction<{ summary: string; keyThemes?: string[] }>(
        ActionType.SUMMARIZE_DOCUMENT,
        {
          promptVariables: {
            document_text: document.extractedText || ""
          }
        },
        projectId,
        userId
      )

      document.summary = summarizeResult.data.summary
      document.summaryStatus = "success"
      await document.save()

      console.log(
        `[DocumentSummarizer] Summarized "${originalName}": ${document.extractedText?.length} chars → ${document.summary?.length} chars`
      )
    } catch (summarizeErr: any) {
      // Summarize thất bại KHÔNG chặn response — document vẫn có extractedText để dùng
      document.summaryStatus = "failed"
      await document.save()

      console.warn(
        `[DocumentSummarizer] Failed to summarize "${originalName}" (summaryStatus=failed): ${summarizeErr?.message}`
      )
    }
  }

  return document
}

export const getProjectDocuments = async (userId: string, projectId: string): Promise<any[]> => {
  await getProjectById(projectId, userId)

  return await ProjectDocument.find({ projectId }).sort({ createdAt: -1 })
}

export const deleteProjectDocument = async (
  userId: string,
  projectId: string,
  documentId: string
): Promise<void> => {
  await getProjectById(projectId, userId)

  const document = await ProjectDocument.findOne({ _id: documentId, projectId })
  if (!document) {
    throw new ApiError(404, "Document not found", "DOCUMENT_NOT_FOUND")
  }

  await ProjectDocument.deleteOne({ _id: documentId, projectId })
  await destroyDocumentAsset(document.cloudinaryPublicId)
}
