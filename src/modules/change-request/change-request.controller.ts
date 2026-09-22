/**
 * Controller change request mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 16–30. FLF-171.
 * Mọi hành động trả `changeRequestDetailSchema` (CR + vị trí + group + câu hỏi đang chờ).
 */

import type { Request, Response } from "express"
import { sendSuccess } from "../../shared/types/api-response.js"
import { authorizeMode1, mode1Handler, parseInput, type Mode1Auth } from "../import/mode1.http.js"
import { Mode1Error } from "../import/mode1.errors.js"
import {
  answersRequestSchema,
  closeRequestSchema,
  createChangeRequestSchema,
  crParamsSchema,
  emptyRequestSchema,
  groupDecisionRequestSchema,
  groupIdSchema,
  listChangeRequestsQuerySchema,
  locationIdSchema,
  patchLocationRequestSchema
} from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import * as crService from "./change-request.service.js"
import { answerClarification, runClarify } from "./clarify.service.js"
import { runImpact } from "./cr-impact.service.js"
import { decideGroup } from "./decision.service.js"
import { patchLocation } from "./location.service.js"
import { runPropose } from "./propose.service.js"
import { runVerify } from "./verify.service.js"

const loadCr = async (req: Request): Promise<{ auth: Mode1Auth; cr: IChangeRequest }> => {
  const auth = await authorizeMode1(req)
  const { crId } = parseInput(crParamsSchema, req.params)
  return { auth, cr: await crService.requireCr(auth.projectId, crId) }
}

const detail = async (res: Response, cr: IChangeRequest, status = 200) => sendSuccess(res, status, await crService.toDetail(cr))

/** Hành động không có body: kiểm body rỗng, chạy, trả chi tiết. */
const action = (run: (cr: IChangeRequest, auth: Mode1Auth) => Promise<void>) =>
  mode1Handler(async (req, res) => {
    const { auth, cr } = await loadCr(req)
    parseInput(emptyRequestSchema, req.body)
    await run(cr, auth)
    return detail(res, cr)
  })

export const createCr = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const raw = (req.body ?? {}) as Record<string, unknown>
  if (!raw.source || typeof raw.requester !== "string" || !raw.requester.trim()) {
    throw new Mode1Error("CR_SOURCE_REQUIRED", "Change request cần nguồn (source) và người yêu cầu (requester)")
  }
  const body = parseInput(createChangeRequestSchema, req.body)
  const cr = await crService.createCr(auth.projectId, auth.userId, body)
  // Bản xem trước hết hạn / không phải của mình ⇒ CR vẫn tạo (3.1 không phụ thuộc bản xem trước), báo để FE nói rõ
  if (body.preview_id && !cr.seed) return sendSuccess(res, 201, await crService.toDetail(cr), { seed_dropped: true })
  return detail(res, cr, 201)
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
  const { auth, cr } = await loadCr(req)
  const body = parseInput(answersRequestSchema, req.body)
  await answerClarification(cr, auth.userId, body.answers)
  return detail(res, cr)
})

export const impact = action((cr) => runImpact(cr))
export const propose = action((cr, auth) => runPropose(cr, auth.userId))
export const verify = action((cr, auth) => runVerify(cr, auth.userId))
export const submit = action((cr) => crService.submitCr(cr))
export const revise = action((cr) => crService.reviseCr(cr))

export const updateLocation = mode1Handler(async (req, res) => {
  const { cr } = await loadCr(req)
  const locId = parseInput(locationIdSchema, req.params.locId)
  const body = parseInput(patchLocationRequestSchema, req.body)
  await patchLocation(cr, locId, body)
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
  const { cr } = await loadCr(req)
  const body = parseInput(closeRequestSchema, req.body)
  await crService.cancelCr(cr, body.reason)
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
