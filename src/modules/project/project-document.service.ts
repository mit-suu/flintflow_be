import mongoose from "mongoose"
import { ApiError } from "../../shared/utils/api-error.js"
import { ProjectDocument } from "./project-document.model.js"
import { getProjectById } from "./project.service.js"
import { uploadFileToCloudinary } from "../../shared/utils/cloudinary.js"
import { destroyDocumentAsset } from "./project-document.storage.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { parseFileContent, type FileTextWarning } from "../../shared/utils/file-text.js"
import { assignDocCodes } from "./document-code.service.js"
import { contentHashOf, findDuplicate, findVersionCandidates, type ExistingDocument } from "./document-dedupe.js"
import { paragraphId, splitParagraphs } from "../../shared/ai/document-paragraphs.js"
import { alignOutline, extractDocxHeadings, isDocx } from "../../shared/ai/document-retrieval/docx-outline.js"
import { deleteDocumentChunks, saveDocumentChunks } from "../../shared/ai/document-retrieval/chunk-index.service.js"
import type { OutlineEntry } from "../../shared/ai/document-retrieval/chunker.js"
import { assertReferenceProjectQuota, assertReferenceUploadLimit, type ReferenceTokenLimits } from "./document-token-limit.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"

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

  const allowedExtensions = new Set([".pdf", ".txt", ".md", ".docx", ".doc"])
  const originalName = file.originalname || ""
  const extension = originalName.slice(originalName.lastIndexOf("."))?.toLowerCase() || ""

  // FLF-458 (BF: tài liệu tham khảo không nhận ảnh): đuôi file quyết định — chỉ nhận đuôi trong danh sách, mime gửi kèm không cứu được đuôi sai
  if (!allowedExtensions.has(extension)) {
    throw new ApiError(400, "Chỉ hỗ trợ file PDF, DOCX, MD hoặc TXT.", "UNSUPPORTED_FILE_TYPE")
  }

  // Step 1: Parse nội dung text TRƯỚC khi lưu gì (FLF-398: so trùng / so bản mới cần chữ đã đọc).
  // Lỗi parse KHÔNG làm fail toàn bộ request — document vẫn được lưu với parseStatus = "failed".
  let parsed: { text: string; tokenCount: number } | null = null
  let parseError: string | null = null
  // FLF-449 việc 27: điều Code biết chắc đã mất khi trích (ảnh trong .docx, PDF không có lớp chữ) - FE hiện trên dòng tài liệu
  let parseWarnings: FileTextWarning[] = []
  try {
    const result = await parseFileContent(file.buffer, file.mimetype, extension)
    parseWarnings = result.warnings
    if (result.warnings.includes("pdf_no_text")) {
      // L3: PDF scan / không có lớp chữ ⇒ "failed" ngay lúc tải (không chờ tới lượt rút mới lộ 422); không chunk, không tóm tắt
      parseError = "PDF không có lớp chữ (có thể là bản scan). Hãy gửi lại bản .docx."
      console.warn(`[DocumentParser] "${originalName}" has no text layer (parseStatus=failed)`)
    } else {
      parsed = result
      console.log(`[DocumentParser] Parsed "${originalName}" successfully: ${parsed.text.length} chars, ~${parsed.tokenCount} tokens`)
    }
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
    parseWarnings,
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

  // FLF-458 (business-flow §3.6 "Đọc một lần dùng lại nhiều lần"): AI chỉ đọc tài liệu sau khi báo credit và người dùng
  // xác nhận (`summarizeReferenceDocuments`) — không còn tóm tắt ngay lúc tải lên. `summaryStatus` giữ "pending" (giá trị
  // mặc định của model) khi parse thành công; parse lỗi thì không có gì để đọc.
  return document
}

/** `getActionCost(SUMMARIZE_DOCUMENT)` — 1 tài liệu = 1 lượt AI (Task 2b), không theo độ dài. */
const summarizeCreditCost = async (): Promise<number> => getActionCost(ActionType.SUMMARIZE_DOCUMENT)

/**
 * FLF-458: credit cần để AI đọc các tài liệu tham khảo **chưa đọc** của dự án (`summaryStatus: "pending"`, parse thành
 * công) — báo trước khi chạy hàng loạt (business-flow §2), độc lập với `creditEstimateFor` của I-4. `withBalance`: kèm số
 * credit khả dụng của ví org sở hữu project (Lead / Analyst).
 */
export const pendingSummaryEstimate = async (
  orgId: string,
  userId: string,
  projectId: string,
  opts: { withBalance: boolean }
): Promise<{ documents: number; credits: number; available_credits: number | null }> => {
  await getProjectById(projectId, orgId)
  const pending = await ProjectDocument.countDocuments({ projectId, supersededBy: null, parseStatus: "success", summaryStatus: "pending" })
  const credits = pending * (await summarizeCreditCost())
  if (!pending || !opts.withBalance) return { documents: pending, credits, available_credits: null }
  const walletOrgId = await resolveWalletOrg(projectId)
  if (!walletOrgId) return { documents: pending, credits, available_credits: null }
  const wallet = await getOrCreateWallet(userId, undefined, walletOrgId)
  return { documents: pending, credits, available_credits: wallet.balance - wallet.reserved }
}

/**
 * FLF-458: số tài liệu tham khảo đang chờ đọc + credit để đọc — cộng vào số báo trước ở màn đọc khung (`GET /import`
 * `credit_estimate`, BF §2: có SRS thì đọc cùng lượt Bắt đầu). Không kiểm quyền (caller đã qua `authorizeMode1`).
 */
export const pendingSummaryCredits = async (projectId: string): Promise<{ documents: number; credits: number }> => {
  const documents = await ProjectDocument.countDocuments({ projectId, supersededBy: null, parseStatus: "success", summaryStatus: "pending" })
  return { documents, credits: documents * (documents ? await summarizeCreditCost() : 0) }
}

/** Một tài liệu `running` quá lâu (lượt đọc chết giữa chừng) thì được giành lại. */
const SUMMARY_CLAIM_TTL_MS = 10 * 60_000

/** FLF-458: bấm Bắt đầu ở màn đọc khung ⇒ đọc luôn các tài liệu tham khảo đang chờ (đã báo credit cùng số của lượt đọc file). */
export const summarizePendingAtStart = async (projectId: string, userId: string): Promise<void> => {
  const { documents } = await pendingSummaryCredits(projectId)
  if (!documents) return
  const orgId = await resolveWalletOrg(projectId)
  if (orgId) await summarizeReferenceDocuments(orgId, userId, projectId)
}

/**
 * FLF-458: AI đọc các tài liệu tham khảo đã tải lên nhưng chưa đọc (`summaryStatus: "pending"` sau khi người dùng xác
 * nhận credit ở `pendingSummaryEstimate`); `documentIds` rỗng ⇒ đọc hết các tài liệu đang chờ. Mỗi tài liệu gọi AI riêng,
 * lỗi một tài liệu không chặn các tài liệu khác (giữ hành vi cũ: parse/summarize lỗi không chặn phần còn lại).
 */
export const summarizeReferenceDocuments = async (
  orgId: string,
  userId: string,
  projectId: string,
  documentIds: readonly string[] = []
): Promise<any[]> => {
  await getProjectById(projectId, orgId)
  const staleRunning = { summaryStatus: "running" as const, summaryClaimedAt: { $lt: new Date(Date.now() - SUMMARY_CLAIM_TTL_MS) } }
  const filter = { projectId, supersededBy: null, parseStatus: "success" as const, $or: [{ summaryStatus: "pending" as const }, staleRunning], ...(documentIds.length ? { _id: { $in: documentIds } } : {}) }
  const candidates = await ProjectDocument.find(filter)
  // Giành từng tài liệu bằng cập nhật nguyên tử: hai lượt đồng thời không cùng gọi AI / trừ credit cho một tài liệu. `running` quá hạn (máy chủ chết giữa chừng) được giành lại.
  const documents = []
  for (const candidate of candidates) {
    const claimed = await ProjectDocument.findOneAndUpdate(
      { _id: candidate._id, supersededBy: null, $or: [{ summaryStatus: "pending" }, staleRunning] },
      { $set: { summaryStatus: "running", summaryClaimedAt: new Date() } },
      { new: true }
    )
    if (claimed) documents.push(claimed)
  }
  const results = []
  // Hết credit giữa chừng: tài liệu đó và các tài liệu sau giữ `pending` (nạp credit rồi đọc lại được), không đánh dấu `failed` hàng loạt
  let creditError: unknown = null
  for (const document of documents) {
    try {
      const summarizeResult = await executeAiAction<{ summary: string; keyThemes?: string[] }>(
        ActionType.SUMMARIZE_DOCUMENT,
        { promptVariables: { document_text: document.extractedText || "" } },
        projectId,
        userId
      )
      document.summary = summarizeResult.data.summary
      document.summaryStatus = "success"
      await document.save()
      console.log(`[DocumentSummarizer] Summarized "${document.originalName}": ${document.extractedText?.length} chars → ${document.summary?.length} chars`)
    } catch (summarizeErr: any) {
      if (summarizeErr?.code === "INSUFFICIENT_CREDIT") {
        creditError = summarizeErr
        console.warn(`[DocumentSummarizer] Hết credit khi đọc "${document.originalName}" - giữ pending, dừng lượt đọc`)
        // Trả tài liệu này và các tài liệu đã giành sau nó về `pending`
        document.summaryStatus = "pending"
        await document.save()
        await ProjectDocument.updateMany({ _id: { $in: documents.slice(documents.indexOf(document) + 1).map((d) => d._id) }, summaryStatus: "running" }, { $set: { summaryStatus: "pending" } })
        break
      }
      document.summaryStatus = "failed"
      await document.save()
      console.warn(`[DocumentSummarizer] Failed to summarize "${document.originalName}" (summaryStatus=failed): ${summarizeErr?.message}`)
    }
    results.push(document)
  }
  if (creditError) throw creditError
  return results
}

/**
 * Tài liệu đang dùng (FLF-398: bản đã bị thay không trả), mỗi bản kèm `replaces` — các bản cũ nó đã thay (tên + mã), để FE hiện
 * "thay cho …".
 */
export const getProjectDocuments = async (orgId: string, projectId: string): Promise<any[]> => {
  await getProjectById(projectId, orgId)

  const [documents, superseded] = await Promise.all([
    // FLF-443: không trả URL kho lưu / khoá kho / chữ đã trích (đọc chữ qua `getReferenceDocumentText`, tải file qua `/download`)
    ProjectDocument.find({ projectId, supersededBy: null }).select("-url -cloudinaryPublicId -fileName -extractedText").sort({ createdAt: -1 }),
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

/**
 * FLF-443: tài liệu của đúng project (id sai định dạng / project khác / org khác ⇒ 404). Bản đã bị thay (`supersededBy`)
 * vẫn đọc được vì trích dẫn cũ còn trỏ tới nó.
 */
export const findProjectDocument = async (orgId: string, projectId: string, documentId: string, fields: string) => {
  await getProjectById(projectId, orgId)
  const notFound = () => new ApiError(404, "Không tìm thấy tài liệu.", "DOCUMENT_NOT_FOUND")
  if (!mongoose.isValidObjectId(documentId)) throw notFound()
  const document = await ProjectDocument.findOne({ _id: documentId, projectId }).select(fields).lean()
  if (!document) throw notFound()
  return document
}

/** FLF-443: chữ đã trích chia đoạn bằng đúng hàm sinh mã `D<n>-P<mm>` của `GET /sources`. Parse lỗi / chưa có mã ⇒ không đoạn. */
export const getReferenceDocumentText = async (orgId: string, projectId: string, documentId: string) => {
  const doc = await findProjectDocument(orgId, projectId, documentId, "originalName docCode extractedText")
  const docCode = doc.docCode ?? null
  const paragraphs =
    docCode && doc.extractedText ? splitParagraphs(doc.extractedText).map((text, i) => ({ para_id: paragraphId(docCode, i), text })) : []
  return { id: String(doc._id), name: doc.originalName, paragraphs }
}
