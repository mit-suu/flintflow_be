/**
 * Controller import mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 2–11. FLF-171.
 * Controller chỉ: kiểm quyền + mode → parse DTO → gọi service → envelope. Nghiệp vụ ở `*.service.ts`.
 */

import type { NextFunction, Request, Response } from "express"
import multer from "multer"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { IMPORT_MAX_FILE_BYTES } from "./import.constants.js"
import { IMPORT_FILE_FIELD, confirmLatestRequestSchema, mappingPatchRequestSchema } from "./import.dto.js"
import * as importService from "./import.service.js"
import * as reuploadService from "./reupload.service.js"
import { authorizeMode1, mode1Handler, parseInput } from "./mode1.http.js"

/**
 * Multer giữ file trong bộ nhớ. Giới hạn cứng gấp đôi giới hạn nghiệp vụ: file hơi quá cỡ vẫn tới preflight để
 * trả `FILE_TOO_LARGE` có bản ghi; file quá lớn hẳn bị chặn ở đây (400).
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_FILE_BYTES * 2, files: 1 } })

export const receiveDocx = (req: Request, res: Response, next: NextFunction): void => {
  upload.single(IMPORT_FILE_FIELD)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, `Upload lỗi: ${err.message}`, "VALIDATION_ERROR"))
    if (err) return next(err)
    next()
  })
}

export const requireFile = (req: Request): importService.UploadedFile => {
  const file = req.file
  if (!file) throw new ApiError(400, `Thiếu file .docx (field "${IMPORT_FILE_FIELD}")`, "VALIDATION_ERROR")
  // multer đọc tên file theo latin1 — đổi lại UTF-8 để giữ tên tiếng Việt
  const originalname = Buffer.from(file.originalname, "latin1").toString("utf8")
  return { buffer: file.buffer, originalname, size: file.size }
}

export const uploadImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const doc = await importService.uploadImport(auth.projectId, auth.userId, requireFile(req))
  return sendSuccess(res, 201, { import: importService.toImportDto(doc) })
})

export const confirmLatest = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(confirmLatestRequestSchema, req.body)
  const doc = await importService.confirmLatest(auth.projectId, body.import_id)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const getImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  return sendSuccess(res, 200, await importService.getImportView(auth.projectId))
})

export const patchMapping = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(mappingPatchRequestSchema, req.body)
  const doc = await importService.patchMapping(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const reupload = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const diff = await reuploadService.reupload(auth.projectId, auth.userId, requireFile(req))
  return sendSuccess(res, 201, reuploadService.toReuploadDto(diff))
})
