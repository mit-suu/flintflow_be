import type mongoose from "mongoose"
import { ApiError } from "../../shared/utils/api-error.js"
import { ProjectDocument } from "./project-document.model.js"
import { getProjectById } from "./project.service.js"
import { uploadFileToCloudinary } from "../../shared/utils/cloudinary.js"
import { destroyDocumentAsset } from "./project-document.storage.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { parseFileContent } from "../../shared/utils/file-text.js"
import { assignDocCodes } from "./document-code.service.js"
import { contentHashOf, findDuplicate, findVersionCandidates, type ExistingDocument } from "./document-dedupe.js"
import { splitParagraphs } from "../../shared/ai/document-paragraphs.js"
import { alignOutline, extractDocxHeadings, isDocx } from "../../shared/ai/document-retrieval/docx-outline.js"
import { deleteDocumentChunks, saveDocumentChunks } from "../../shared/ai/document-retrieval/chunk-index.service.js"
import type { OutlineEntry } from "../../shared/ai/document-retrieval/chunker.js"
import { assertReferenceProjectQuota, assertReferenceUploadLimit, type ReferenceTokenLimits } from "./document-token-limit.js"

/**
 * FLF-393: heading thật của file .docx, khớp về chỉ số đoạn - chữ phẳng mất style heading nên chỉ lấy được lúc còn buffer.
 * File khác hoặc đọc lỗi ⇒ `[]` (chunker dò heading trên chữ).
 */
const outlineOf = async (file: Express.Multer.File, extension: string, text: string): Promise<OutlineEntry[]> => {
  if (!isDocx(file.mimetype, extension)) return []
  try {
    return alignOutline(splitParagraphs(text), await extractDocxHeadings(file.buffer))
  } catch (err) {
    console.warn(`[DocumentChunks] Không đọc được heading của "${file.originalname}": ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * FLF-398: lựa chọn của người dùng sau khi BE báo "có thể là bản mới" (`409 POSSIBLE_NEW_VERSION`). Không gửi ⇒ BE so tên /
 * nội dung và hỏi lại khi có ứng viên.
 */
export interface UploadChoice {
  /** "Thay bản cũ": id tài liệu đang dùng mà file này thay. */
  replaceDocumentId?: string | null
  /** "Giữ cả hai": không hỏi bản mới nữa (trùng hệt vẫn chặn). */
  keepBoth?: boolean
}

const existingDocuments = async (projectId: mongoose.Types.ObjectId | string): Promise<ExistingDocument[]> => {
  const docs = await ProjectDocument.find({ projectId })
    .select("_id originalName docCode contentHash extractedText supersededBy")
    .lean()
  return docs.map((d) => ({
    id: String(d._id),
    name: d.originalName,
    docCode: d.docCode ?? null,
    contentHash: d.contentHash ?? null,
    extractedText: d.extractedText ?? null,
    supersededBy: d.supersededBy ? String(d.supersededBy) : null
  }))
}

export const uploadProjectDocument = async (
  orgId: string,
  userId: string,
  projectId: string,
  file: Express.Multer.File,
  choice: UploadChoice = {}
): Promise<any> => {
  if (!file) {
    throw new ApiError(400, "Vui lòng chọn file để tải lên.", "FILE_REQUIRED")
  }

  const project = await getProjectById(projectId, orgId)

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
    throw new ApiError(400, "Chỉ hỗ trợ file PDF, DOCX, MD hoặc TXT.", "UNSUPPORTED_FILE_TYPE")
  }

  // Step 1: Parse nội dung text TRƯỚC khi lưu gì (FLF-398: so trùng / so bản mới cần chữ đã đọc).
  // Lỗi parse KHÔNG làm fail toàn bộ request — document vẫn được lưu với parseStatus = "failed".
  let parsed: { text: string; tokenCount: number } | null = null
  let parseError: string | null = null
  try {
    parsed = await parseFileContent(file.buffer, file.mimetype, extension)
    console.log(`[DocumentParser] Parsed "${originalName}" successfully: ${parsed.text.length} chars, ~${parsed.tokenCount} tokens`)
  } catch (parseErr: any) {
    parseError = parseErr?.message || "Unknown parse error"
    console.warn(`[DocumentParser] Failed to parse "${originalName}" (parseStatus=failed): ${parseErr?.message}`)
  }

  // FLF-405: trần token mỗi lần tải — ngay sau khi trích chữ, chưa lưu / chưa tốn credit. Parse lỗi (không có chữ để đếm)
  // ⇒ giữ hành vi cũ: lưu `failed`, không tính vào tổng.
  let tokenLimits: ReferenceTokenLimits | null = null
  if (parsed) {
    tokenLimits = await assertReferenceUploadLimit({ orgId: project.organizationId ?? orgId, file: originalName, tokenCount: parsed.tokenCount })
  }

  // Step 2 (FLF-398): trùng hệt ⇒ chặn; có thể là bản mới ⇒ hỏi (trừ khi người dùng đã chọn). Chưa ghi gì, chưa tốn credit.
  const contentHash = contentHashOf(file.buffer)
  const existing = await existingDocuments(project._id)
  const duplicate = findDuplicate(existing, contentHash, parsed?.text ?? null)
  if (duplicate) {
    throw duplicate.supersededBy
      ? new ApiError(409, `Đây là bản cũ "${duplicate.document.name}" đã được thay bởi "${duplicate.supersededBy.name}".`, "DUPLICATE_DOCUMENT", {
          document: duplicate.document,
          superseded_by: duplicate.supersededBy
        })
      : new ApiError(409, `Tài liệu này đã có trong dự án: "${duplicate.document.name}".`, "DUPLICATE_DOCUMENT", { document: duplicate.document })
  }
  const replaced = choice.replaceDocumentId ? existing.find((d) => d.id === choice.replaceDocumentId) : undefined
  if (choice.replaceDocumentId) {
    if (!replaced) throw new ApiError(404, "Không tìm thấy tài liệu cần thay.", "DOCUMENT_NOT_FOUND")
    if (replaced.supersededBy) throw new ApiError(409, "Tài liệu cần thay đã được bản khác thay trước đó.", "DOCUMENT_ALREADY_SUPERSEDED")
  } else if (!choice.keepBoth) {
    const candidates = findVersionCandidates(existing, originalName, parsed?.text ?? null)
    if (candidates.length) {
      throw new ApiError(409, `Có vẻ đây là bản mới của "${candidates[0].name}". Bạn muốn thay bản cũ hay giữ cả hai?`, "POSSIBLE_NEW_VERSION", {
        candidates
      })
    }
  }

  // FLF-405: trần tổng dự án theo gói — sau bước hỏi bản mới để "Thay bản cũ" được trừ token bản bị thay; vẫn trước
  // Cloudinary / ghi DB.
  if (parsed && tokenLimits) {
    await assertReferenceProjectQuota({
      limits: tokenLimits,
      projectId: project._id,
      file: originalName,
      tokenCount: parsed.tokenCount,
      replaceDocumentId: replaced?.id ?? null
    })
  }

  // Step 3: Upload lên Cloudinary
  const uploadResult = await uploadFileToCloudinary(file, {
    folder: `flintflow/projects/${project._id}`
  })

  // FLF-393: heading thật của .docx (chỉ đọc được lúc còn buffer) - cây section để cắt chunk
  const outline = parsed ? await outlineOf(file, extension, parsed.text) : []

  // Step 4: Lưu document record kèm kết quả parse
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
    contentHash,
    extractedText: parsed?.text ?? null,
    tokenCount: parsed?.tokenCount ?? null,
    parseStatus: parsed ? "success" : "failed",
    parseError,
    ...(outline.length ? { outline } : {}),
    summaryStatus: "pending"
  })
  // FLF-292: số tài liệu cho mã đoạn `D<n>-P<m>` — gán ngay để lượt chat kế tiếp đã có mã ổn định
  await assignDocCodes(project._id)
  // Số gán bằng updateOne ⇒ nạp lại để response mang mã `D<n>` (FE hiện "thay cho … (D1)")
  document.docCode = (await ProjectDocument.findById(document._id).select("docCode").lean())?.docCode ?? null
  // FLF-398: "Thay bản cũ" ⇒ bản cũ ra khỏi danh sách / ngữ cảnh model, giữ lại cho trích dẫn cũ
  if (replaced) {
    await ProjectDocument.updateOne(
      { _id: replaced.id, projectId: project._id, supersededBy: null },
      { $set: { supersededBy: document._id, supersededAt: new Date() } }
    )
  }
  // FLF-393: cắt sẵn thành chunk theo cây section - lượt chat / Draft chỉ nạp đoạn liên quan khi tài liệu vượt trần
  if (parsed) await saveDocumentChunks(project._id, document._id, parsed.text, outline)

  // Step 5: Summarize document bằng AI (Task 2b)
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

/**
 * Tài liệu đang dùng (FLF-398: bản đã bị thay không trả), mỗi bản kèm `replaces` — các bản cũ nó đã thay (tên + mã), để FE hiện
 * "thay cho …".
 */
export const getProjectDocuments = async (orgId: string, projectId: string): Promise<any[]> => {
  await getProjectById(projectId, orgId)

  const [documents, superseded] = await Promise.all([
    ProjectDocument.find({ projectId, supersededBy: null }).sort({ createdAt: -1 }),
    ProjectDocument.find({ projectId, supersededBy: { $ne: null } }).select("_id originalName docCode supersededBy").lean()
  ])
  return documents.map((d) => ({
    ...d.toJSON(),
    replaces: superseded
      .filter((s) => String(s.supersededBy) === String(d._id))
      .map((s) => ({ id: String(s._id), name: s.originalName, doc_code: s.docCode ?? null }))
  }))
}

export const deleteProjectDocument = async (
  orgId: string,
  projectId: string,
  documentId: string
): Promise<void> => {
  await getProjectById(projectId, orgId)

  const document = await ProjectDocument.findOne({ _id: documentId, projectId })
  if (!document) {
    throw new ApiError(404, "Không tìm thấy tài liệu.", "DOCUMENT_NOT_FOUND")
  }

  await ProjectDocument.deleteOne({ _id: documentId, projectId })
  // FLF-398: xoá bản mới ⇒ bản cũ nó đã thay được dùng lại (không để bản cũ ẩn mãi)
  await ProjectDocument.updateMany({ projectId, supersededBy: document._id }, { $set: { supersededBy: null, supersededAt: null } })
  // FLF-393: chunk của tài liệu đã xoá không còn dùng
  await deleteDocumentChunks(documentId)
  await destroyDocumentAsset(document.cloudinaryPublicId)
}
