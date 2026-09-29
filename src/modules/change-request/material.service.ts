/**
 * Tài liệu bổ sung của CR (mode 1 v3 phase 7): người dùng dán chữ hoặc upload file để AI có dữ kiện viết nội dung
 * (3.1 lúc tạo, hoặc khi trả lời câu hỏi 3.3). Chỉ lưu **chữ** — file chữ tách tại chỗ (`parseFileContent`), ảnh nhờ
 * Gemini chép chữ + mô tả (`CR_MATERIAL_IMAGE`). Chỉ thêm / xoá được trước 3.4 (`draft`, `awaiting_answers`) — sau đó
 * vị trí đã tìm + khoá theo nội dung lúc đó.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { CrMaterialImageOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isTextFile, parseFileContent } from "../../shared/utils/file-text.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { imageMime } from "../render/import-media.js"
import { CR_MAX_MATERIALS, clipMaterialText, formatMaterialId, type CrMaterialKind } from "./change-request.constants.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus } from "./change-request.service.js"
import type { CrStatus } from "./change-request.state.js"

/** Trạng thái còn thêm / xoá được tài liệu: trước khi AI tìm vị trí (3.4). */
export const MATERIAL_EDITABLE_STATUSES: readonly CrStatus[] = ["draft", "awaiting_answers"]

export interface UploadedFile {
  buffer: Buffer
  mimetype: string
  originalname: string
}

export type MaterialInput = { name: string; text: string } | { file: UploadedFile }

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

/** Vòng làm rõ tài liệu này đi kèm: 0 = lúc tạo (3.1), n = đang trả lời vòng n. */
const currentRound = (cr: IChangeRequest): number => (cr.status === "awaiting_answers" ? cr.clarifications.length : 0)

const nextMaterialId = (cr: IChangeRequest): string => {
  const max = (cr.materials ?? []).reduce((n, m) => Math.max(n, Number(m.material_id.slice(1)) || 0), 0)
  return formatMaterialId(max + 1)
}

/** Ảnh ⇒ Gemini chép chữ + mô tả. Hết credit ⇒ 402, lỗi AI ⇒ 502 (không có bước nào để dừng / chạy tiếp). */
const readImage = async (cr: IChangeRequest, userId: string, file: UploadedFile, mime: "image/png" | "image/jpeg"): Promise<string> => {
  const result = await withMeteredAi<CrMaterialImageOutput>(
    { projectId: String(cr.projectId), userId, stepId: `C-1:${cr.cr_id}` },
    ActionType.CR_MATERIAL_IMAGE,
    { title: cr.title, file_name: file.originalname },
    { images: [{ mime, data: file.buffer.toString("base64") }] }
  )
  if (!result.ok) {
    if (result.reason === "credits") throw new ApiError(402, result.message, "INSUFFICIENT_CREDIT")
    throw new ApiError(502, "AI chưa đọc được ảnh này — thử lại, hoặc dán nội dung ảnh dưới dạng chữ", "AI_PROVIDER_ERROR")
  }
  return result.data.text
}

const readFile = async (cr: IChangeRequest, userId: string, file: UploadedFile): Promise<{ kind: CrMaterialKind; text: string }> => {
  const mime = imageMime(file.buffer)
  if (mime) return { kind: "image", text: await readImage(cr, userId, file, mime) }
  const ext = extensionOf(file.originalname)
  if (!isTextFile(file.mimetype, ext)) {
    throw new Mode1Error("CR_MATERIAL_UNSUPPORTED", "Chỉ nhận tài liệu .docx, .pdf, .txt, .md hoặc ảnh PNG / JPEG", { name: file.originalname })
  }
  try {
    return { kind: "file", text: (await parseFileContent(file.buffer, file.mimetype, ext)).text }
  } catch {
    throw new Mode1Error("CR_MATERIAL_EMPTY", `Không đọc được nội dung "${file.originalname}" — file hỏng hoặc không có chữ`, { name: file.originalname })
  }
}

export const addMaterial = async (cr: IChangeRequest, userId: string, input: MaterialInput): Promise<string> => {
  assertCrStatus(cr, MATERIAL_EDITABLE_STATUSES, cr.status)
  if ((cr.materials ?? []).length >= CR_MAX_MATERIALS) {
    throw new Mode1Error("CR_MATERIAL_LIMIT", `Mỗi change request đính kèm tối đa ${CR_MAX_MATERIALS} tài liệu — xoá bớt tài liệu cũ trước`, { max: CR_MAX_MATERIALS })
  }
  const read = "file" in input ? await readFile(cr, userId, input.file) : { kind: "text" as const, text: input.text }
  const clipped = clipMaterialText(read.text)
  if (!clipped.text) {
    const name = "file" in input ? input.file.originalname : input.name
    throw new Mode1Error("CR_MATERIAL_EMPTY", `"${name}" không có nội dung chữ nào`, { name })
  }
  const materialId = nextMaterialId(cr)
  cr.materials.push({
    material_id: materialId,
    kind: read.kind,
    name: ("file" in input ? input.file.originalname : input.name).slice(0, 200),
    ...clipped,
    round: currentRound(cr),
    added_at: new Date()
  })
  cr.markModified("materials")
  await cr.save()
  return materialId
}

export const removeMaterial = async (cr: IChangeRequest, materialId: string): Promise<void> => {
  assertCrStatus(cr, MATERIAL_EDITABLE_STATUSES, cr.status)
  const before = cr.materials.length
  cr.materials = cr.materials.filter((m) => m.material_id !== materialId)
  if (cr.materials.length === before) throw new Mode1Error("CR_MATERIAL_NOT_FOUND", "Không tìm thấy tài liệu này trong change request", { material_id: materialId })
  cr.markModified("materials")
  await cr.save()
}
