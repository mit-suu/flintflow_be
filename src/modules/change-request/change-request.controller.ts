/**
 * Controller change request mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 16–30. FLF-171.
 * Mọi hành động trả `changeRequestDetailSchema` (CR + vị trí + group + câu hỏi đang chờ).
 */

import type { NextFunction, Request, Response } from "express"
import multer from "multer"
import { IMPORT_MAX_FILE_BYTES } from "../import/import.constants.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { authorizeMode1, mode1Handler, parseInput, type Mode1Auth } from "../import/mode1.http.js"
import { Mode1Error } from "../import/mode1.errors.js"
import {
  addMaterialRequestSchema,
  amendRequestSchema,
  crMessageRequestSchema,
  answersRequestSchema,
  closeRequestSchema,
  createChangeRequestSchema,
  crParamsSchema,
  emptyRequestSchema,
  groupDecisionRequestSchema,
  groupIdSchema,
  listChangeRequestsQuerySchema,
  locationIdSchema,
  diagramPreviewQuerySchema,
  materialParamsSchema,
  ownerStepDraftRequestSchema,
  revertRequestSchema,
  patchLocationRequestSchema,
  approveExtractionSchema,
  extractionParamsSchema,
  type ExtractionDto
} from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import * as crService from "./change-request.service.js"
import * as extractionService from "./extraction.service.js"
import type { IRequirementExtraction } from "./requirement-extraction.model.js"
import { amendCr, answerClarification, runClarify } from "./clarify.service.js"
import { handleCrMessage } from "./cr-message.service.js"
import { runImpact } from "./cr-impact.service.js"
import { decideGroup } from "./decision.service.js"
import { patchLocation } from "./location.service.js"
import { crDocumentDiff } from "./cr-document-diff.service.js"
import { diagramPreview } from "./diagram-preview.service.js"
import type { OriginalDiagramKind } from "../spine/spine.types.js"
import { addMaterial, removeMaterial } from "./material.service.js"
import { draftInOwnerStep, runPropose } from "./propose.service.js"
import { runVerify } from "./verify.service.js"
import { createRevertCr } from "./revert-cr.service.js"
import { assertPackageNotPending } from "../doc-version/review-package.service.js"
import { assertConvertible, markConverted } from "../comment/comment.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { TransactionRejectedError } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"

const loadCr = async (req: Request): Promise<{ auth: Mode1Auth; cr: IChangeRequest }> => {
  const auth = await authorizeMode1(req)
  const { crId } = parseInput(crParamsSchema, req.params)
  return { auth, cr: await crService.requireCr(auth.projectId, crId) }
}

/**
 * BF §3.2 / spec UC-45 A6: các bước áp dụng CR (C-1…C-6: tài liệu bổ sung, gộp lệnh, làm rõ, tìm vị trí, đề xuất, sửa vị trí,
 * kiểm, xác nhận, chạy tiếp) chỉ người tạo CR làm. Người khác ⇒ 403 `CR_NOT_REQUESTER` "đang treo ở <ai>".
 */
const loadOwnCr = async (req: Request): Promise<{ auth: Mode1Auth; cr: IChangeRequest }> => {
  const loaded = await loadCr(req)
  await crService.assertRequester(loaded.cr, loaded.auth.userId)
  // C-7: gói chờ Lead ⇒ bản nháp khoá; nội dung CR soạn lúc này sẽ vào gói nên mọi bước C-1…C-6 cũng dừng (business-flow §2)
  assertPackageNotPending((await spineRepository.get(loaded.auth.projectId))?.baseline_submission)
  return loaded
}

const detail = async (res: Response, cr: IChangeRequest, status = 200) => sendSuccess(res, status, await crService.toDetail(cr))

/** Hành động không có body: kiểm body rỗng, chạy, trả chi tiết. */
const action = (run: (cr: IChangeRequest, auth: Mode1Auth) => Promise<void>, opts: { ownerOnly?: boolean } = {}) =>
  mode1Handler(async (req, res) => {
    const { auth, cr } = await (opts.ownerOnly === false ? loadCr(req) : loadOwnCr(req))
    parseInput(emptyRequestSchema, req.body)
    await run(cr, auth)
    return detail(res, cr)
  })

// ─── FLF-338 §3.6.1: rút yêu cầu từ tài liệu thô ────────────────

const toExtractionDto = (e: IRequirementExtraction): ExtractionDto => ({
  document_id: String(e.documentId),
  document_name: e.document_name,
  doc_code: e.doc_code,
  status: e.status,
  items: e.items.map((i) => ({
    id: i.id,
    text: i.text,
    label: i.label,
    para_id: i.para_id ?? null,
    quote: i.quote,
    group: i.group,
    entity_paths: [...i.entity_paths],
    entity_names: i.entity_paths.map((_, n) => i.entity_names?.[n] ?? ""),
    speaker: i.speaker ?? null,
    sides: (i.sides ?? []).map((side) => ({ speaker: side.speaker ?? null, para_id: side.para_id ?? null, quote: side.quote })),
    inference: i.inference
      ? {
          symptom: i.inference.symptom,
          symptom_quote: i.inference.symptom_quote,
          symptom_para_id: i.inference.symptom_para_id ?? null,
          root_cause: i.inference.root_cause ?? "",
          rationale: i.inference.rationale ?? "",
          options: i.inference.options.map((o) => ({ label: o.label, description: o.description ?? null, pros: [...o.pros], cons: [...o.cons], risks: [...o.risks] })),
          recommended: i.inference.recommended ?? null,
          recommendation_reason: i.inference.recommendation_reason ?? null,
          serves_goal: i.inference.serves_goal ?? null
        }
      : null,
    question: i.question ?? null,
    suggested_answers: [...i.suggested_answers],
    include: i.include ?? null,
    drop_reason: i.drop_reason ?? null,
    answer: i.answer ?? null,
    chosen_option: i.chosen_option ?? null,
    cr_id: i.cr_id ?? null
  })),
  situation: {
    current: (e.situation?.current ?? []).map((p) => ({ text: p.text, para_id: p.para_id ?? null, quote: p.quote })),
    desired: (e.situation?.desired ?? []).map((p) => ({ text: p.text, para_id: p.para_id ?? null, quote: p.quote }))
  },
  batches: e.batches ?? 1,
  credits: e.credits,
  approved_at: e.approved_at ? e.approved_at.toISOString() : null,
  created_at: e.createdAt.toISOString(),
  updated_at: e.updatedAt.toISOString()
})

export const extractRequirements = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { documentId } = parseInput(extractionParamsSchema, req.params)
  const extraction = await extractionService.extractRequirements(auth.projectId, auth.userId, documentId)
  return sendSuccess(res, 201, toExtractionDto(extraction))
})

/** FLF-449: số lô + credit dự kiến của lượt rút (tài liệu dài chia lô, mỗi lô một lượt). */
export const estimateExtraction = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { documentId } = parseInput(extractionParamsSchema, req.params)
  return sendSuccess(res, 200, await extractionService.estimateExtraction(auth.projectId, documentId))
})

export const getExtraction = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { documentId } = parseInput(extractionParamsSchema, req.params)
  const extraction = await extractionService.getExtraction(auth.projectId, documentId)
  return sendSuccess(res, 200, extraction ? toExtractionDto(extraction) : null)
})

export const approveExtraction = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { documentId } = parseInput(extractionParamsSchema, req.params)
  const body = parseInput(approveExtractionSchema, req.body)
  const extraction = await extractionService.approveExtraction(auth.projectId, auth.userId, documentId, body)
  return sendSuccess(res, 200, toExtractionDto(extraction))
})

export const createCr = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const raw = (req.body ?? {}) as Record<string, unknown>
  if (!raw.source || typeof raw.requester !== "string" || !raw.requester.trim()) {
    throw new Mode1Error("CR_SOURCE_REQUIRED", "Change request cần có nguồn và người yêu cầu.")
  }
  const body = parseInput(createChangeRequestSchema, req.body)
  // UC-49: chỉ Analyst/Lead chuyển comment (Viewer đã bị `viewerReadOnly` chặn ở tầng app), nguồn phải là "Viewer comment"
  // và comment còn mở — kiểm trước khi tạo để không sinh CR rồi mới báo comment đã xử lý.
  if (body.comment_id) {
    if (body.source.kind !== "viewer_comment") {
      throw new ApiError(400, "Change request tạo từ comment phải có nguồn \"Viewer comment\".", "VALIDATION_ERROR")
    }
    await assertConvertible(auth.projectId, body.comment_id)
  }
  // BF §3.2 C-1: mỗi người một CR mở một lúc (kiểm sau gói chờ duyệt / baseline, trong createCr)
  const cr = await crService.createCr(auth.projectId, auth.userId, body, { enforceOwnOpen: true })
  if (body.comment_id) await markConverted(auth.projectId, body.comment_id, cr.cr_id, auth.userId, requireOrgId(req))
  // Bản xem trước hết hạn / không phải của mình ⇒ CR vẫn tạo (3.1 không phụ thuộc bản xem trước), báo để FE nói rõ
  if (body.preview_id && !cr.seed) return sendSuccess(res, 201, await crService.toDetail(cr), { seed_dropped: true })
  return detail(res, cr, 201)
})

/** BF §3.2: "hoàn tác CR-xxx" = CR mới dựng từ `before` của các Change của CR đã ghi, rồi chạy kiểm như CR thường. */
export const revertCr = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { crId } = parseInput(crParamsSchema, req.params)
  const body = parseInput(revertRequestSchema, req.body)
  const cr = await createRevertCr(auth.projectId, auth.userId, crId, body.requester)
  return detail(res, cr, 201)
})

// ─── tài liệu bổ sung (mode 1 v3 phase 7) ─────────────────────────

/** Field multipart của file tài liệu bổ sung. */
export const MATERIAL_FILE_FIELD = "file"
const materialUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1 } })

/** Multipart ⇒ `req.file`; JSON đi thẳng. Lỗi multer (quá `IMPORT_MAX_FILE_BYTES`…) ⇒ 413 FILE_TOO_LARGE / 400 UPLOAD_FAILED. */
export const receiveMaterial = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.is("multipart/form-data")) return next()
  materialUpload.single(MATERIAL_FILE_FIELD)(req, res, (err: unknown) => {
    // Lỗi multer (quá cỡ…) ⇒ error handler chung trả câu thường (FILE_TOO_LARGE / UPLOAD_FAILED) — FLF-247
    next(err)
  })
}

export const addCrMaterial = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  if (req.file) {
    // multer đọc tên file theo latin1 — đổi lại UTF-8 để giữ tên tiếng Việt
    const originalname = Buffer.from(req.file.originalname, "latin1").toString("utf8")
    await addMaterial(cr, auth.userId, { file: { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname } })
  } else {
    await addMaterial(cr, auth.userId, parseInput(addMaterialRequestSchema, req.body))
  }
  return detail(res, cr, 201)
})

export const deleteCrMaterial = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { crId, mid } = parseInput(materialParamsSchema, req.params)
  const cr = await crService.requireCr(auth.projectId, crId)
  await crService.assertRequester(cr, auth.userId)
  await removeMaterial(cr, mid)
  return detail(res, cr)
})

/** Phase 8 (chat): gộp thêm một lệnh sửa vào CR chưa nộp. */
export const amend = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  const body = parseInput(amendRequestSchema, req.body)
  await amendCr(cr, auth.userId, body.instruction)
  return detail(res, cr)
})

/** FLF-375: tin nhắn trong lúc CR mở — lệnh sửa gộp vào CR, câu hỏi được trả lời (không thành yêu cầu bổ sung). */
export const message = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  const body = parseInput(crMessageRequestSchema, req.body)
  const outcome = await handleCrMessage(cr, auth.userId, body.text, body.language)
  return sendSuccess(res, 200, { ...(await crService.toDetail(cr)), message: outcome })
})

export const listCrs = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const query = parseInput(listChangeRequestsQuerySchema, req.query)
  return sendSuccess(res, 200, await crService.listCrs(auth.projectId, query.status))
})

export const getCr = mode1Handler(async (req, res) => {
  const { cr } = await loadCr(req)
  return detail(res, cr)
})

export const clarify = action((cr, auth) => runClarify(cr, auth.userId))

export const answers = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  const body = parseInput(answersRequestSchema, req.body)
  await answerClarification(cr, auth.userId, body.answers)
  return detail(res, cr)
})

export const impact = action((cr) => runImpact(cr))
export const propose = action((cr, auth) => runPropose(cr, auth.userId))
export const verify = action((cr, auth) => runVerify(cr, auth.userId))
/**
 * C-6 xác nhận & ghi (BF §3.2): luật Spine gãy trên nội dung hiện tại ⇒ **cờ đỏ trước khi ghi** (chạy lại kiểm, không ném
 * lỗi thô); người khác ghi đúng lúc này (lệch spine_version) ⇒ "ai xác nhận trước thì ghi trước" — kiểm lại trên bản mới
 * một lần nữa rồi ghi.
 */
export const submit = action(async (cr, auth) => {
  try {
    await crService.submitCr(cr, auth.userId)
  } catch (err) {
    if (err instanceof TransactionRejectedError) {
      cr.submitted_at = null
      await runVerify(cr, auth.userId)
      return
    }
    if (err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT) {
      await crService.submitCr(cr, auth.userId)
      return
    }
    throw err
  }
})

/** BF §3.2: mục đang có bản sửa chưa xác nhận của CR chưa đóng — hiện trong tài liệu cho mọi người. */
export const listPendingSections = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  return sendSuccess(res, 200, await crService.listPendingSections(auth.projectId))
})
export const revise = action((cr) => crService.reviseCr(cr), { ownerOnly: false })

export const updateLocation = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  const locId = parseInput(locationIdSchema, req.params.locId)
  const body = parseInput(patchLocationRequestSchema, req.body)
  await patchLocation(cr, locId, body, auth.userId)
  return detail(res, cr)
})

/** §4.13: ảnh của vị trí sơ đồ gốc — sơ đồ FlintFlow vẽ từ dữ liệu sau CR, hoặc ảnh gốc của file (`variant=original`). Không ghi gì, không gọi AI. Ai xem được CR thì xem được. */
export const locationDiagramPreview = mode1Handler(async (req, res) => {
  const { cr } = await loadCr(req)
  const locId = parseInput(locationIdSchema, req.params.locId)
  const query = parseInput(diagramPreviewQuerySchema, req.query)
  const preview = await diagramPreview(cr, locId, query.kind as OriginalDiagramKind, query.owner ?? null, { part: query.part, variant: query.variant })
  res.setHeader("Content-Type", preview.mime)
  res.setHeader("Cache-Control", "private, no-store")
  res.setHeader("X-Diagram-Parts", String(preview.parts))
  res.setHeader("Access-Control-Expose-Headers", "X-Diagram-Parts")
  return res.status(200).send(preview.image)
})

/** FLF-495 (#23b): đề xuất của CR tô lên tài liệu — dựng khô hai bản (hiện tại / sau CR), không ghi, không gọi AI. Ai xem được CR thì xem được. */
export const documentDiff = mode1Handler(async (req, res) => {
  const { cr } = await loadCr(req)
  return sendSuccess(res, 200, await crDocumentDiff(cr))
})

/** BPMN 3.9 (mode 1 v3): sửa đề xuất một vị trí bằng skill của step sở hữu, theo hướng của BA — chỉ ghi đề xuất. */
export const ownerStepDraft = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadOwnCr(req)
  const locId = parseInput(locationIdSchema, req.params.locId)
  const body = parseInput(ownerStepDraftRequestSchema, req.body)
  await draftInOwnerStep(cr, auth.userId, locId, body.instruction)
  return detail(res, cr)
})

export const decision = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadCr(req)
  const groupId = parseInput(groupIdSchema, req.params.gid)
  const body = parseInput(groupDecisionRequestSchema, req.body)
  await decideGroup(cr, auth.userId, groupId, body)
  return detail(res, cr)
})

export const close = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadCr(req)
  const body = parseInput(closeRequestSchema, req.body)
  await crService.closeCr(cr, auth.userId, body.reason)
  return detail(res, cr)
})

export const cancel = mode1Handler(async (req, res) => {
  const { auth, cr } = await loadCr(req)
  const body = parseInput(closeRequestSchema, req.body)
  await crService.cancelCr(cr, body.reason, { userId: auth.userId, role: req.orgContext?.role })
  return detail(res, cr)
})

/** UC-75: chạy lại bước AI đang dừng theo trạng thái. */
export const resume = action(async (cr, auth) => {
  if (cr.status === "clarifying") return runClarify(cr, auth.userId)
  if (cr.status === "proposing") return runPropose(cr, auth.userId)
  if (cr.status === "verifying") return runVerify(cr, auth.userId)
  throw new Mode1Error("CR_INVALID_TRANSITION", `${cr.cr_id} không có bước AI nào đang dừng`, {
    status: cr.status,
    to: cr.status,
    allowed: ["clarifying", "proposing", "verifying"]
  })
})
