import { Router } from "express"
import * as crController from "./change-request.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Change requests (mode 1)
 *   description: Sửa SRS đã có baseline qua change request — làm rõ, tìm vị trí + khoá, đề xuất, kiểm, duyệt, ghi Track Changes (FLF-171)
 *
 * components:
 *   parameters:
 *     Mode1ProjectId: { in: path, name: projectId, required: true, schema: { type: string } }
 *     CrId: { in: path, name: crId, required: true, schema: { type: string, example: CR-001 } }
 *   responses:
 *     CrDetail:
 *       description: "`{ change_request, locations, groups, pending_questions }` — xem import-change-contract.md"
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests:
 *   post:
 *     summary: Tạo change request (UC-48, nút 3.1) — cần baseline v0; source + requester bắt buộc
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, description, source, requester]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               source:
 *                 type: object
 *                 required: [kind]
 *                 properties:
 *                   kind: { type: string, enum: [stakeholder_email, meeting_minutes, gap_report, reupload, viewer_comment, verbal, chat] }
 *                   ref: { type: string, nullable: true }
 *                   note: { type: string, nullable: true }
 *               requester: { type: string }
 *     responses:
 *       201: { $ref: '#/components/responses/CrDetail' }
 *       400: { description: CR_SOURCE_REQUIRED, VALIDATION_ERROR }
 *       409: { description: CR_REQUIRES_BASELINE }
 *   get:
 *     summary: Danh sách change request, mới nhất trước
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - { in: query, name: status, schema: { type: string } }
 *     responses:
 *       200: { description: "`ChangeRequest[]`" }
 */
router.post("/:projectId/change-requests", authMiddleware, crController.createCr)
router.get("/:projectId/change-requests", authMiddleware, crController.listCrs)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}:
 *   get:
 *     summary: Chi tiết change request — vị trí, đề xuất, kết quả kiểm, group
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       404: { description: CR_NOT_FOUND }
 */
router.get("/:projectId/change-requests/:crId", authMiddleware, crController.getCr)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}/clarify:
 *   post:
 *     summary: AI làm rõ CR (C-2, nút 3.2) — mơ hồ ⇒ awaiting_answers kèm câu hỏi; rõ ⇒ impact_review
 *     description: Hết credit / lỗi AI ⇒ `paused`, gọi `/resume`.
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION }
 * /api/v1/projects/{projectId}/change-requests/{crId}/answers:
 *   post:
 *     summary: Trả lời câu hỏi làm rõ rồi chạy lại C-2 (UC-49, nút 3.3)
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answers]
 *             properties:
 *               answers: { type: array, items: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       400: { description: VALIDATION_ERROR (số câu trả lời khác số câu hỏi) }
 *       409: { description: CR_INVALID_TRANSITION }
 * /api/v1/projects/{projectId}/change-requests/{crId}/impact:
 *   post:
 *     summary: Tìm vị trí ảnh hưởng + khoá phần tử Spine (C-3, nút 3.4–3.5) — tất định
 *     description: "Mode 1 v2 — vị trí là phần tử Spine: đích C-2 + phần tử tham chiếu tới nó, phần tử nhắc mã/tên của đích, từ khoá."
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: "PATH_LOCKED (`meta.locked[{ path, cr_id }]`), CR_INVALID_TRANSITION" }
 * /api/v1/projects/{projectId}/change-requests/{crId}/propose:
 *   post:
 *     summary: AI đề xuất edit / comment / not_related cho từng vị trí (C-4, nút 3.6), gom change group
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION }
 * /api/v1/projects/{projectId}/change-requests/{crId}/verify:
 *   post:
 *     summary: Kiểm đề xuất (C-5, nút 3.7–3.8) — code chặn + AI consistency (vàng)
 *     description: Trượt ⇒ `proposing` (AI làm lại, ≤ 2 lần) hoặc `manual_fix`.
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION, CR_VALUE_CHANGED }
 * /api/v1/projects/{projectId}/change-requests/{crId}/submit:
 *   post:
 *     summary: Nộp CR để duyệt (UC-51, nút 3.11)
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: "CR_LOCATION_UNCONCLUDED (`meta.location_ids`), CR_INVALID_TRANSITION" }
 * /api/v1/projects/{projectId}/change-requests/{crId}/revise:
 *   post:
 *     summary: Sửa lại CR khi mọi group bị từ chối — khoá lại phần tử, về proposing (UC-52)
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: PATH_LOCKED, CR_INVALID_TRANSITION }
 * /api/v1/projects/{projectId}/change-requests/{crId}/resume:
 *   post:
 *     summary: Tiếp tục bước AI đang dừng — clarifying / proposing / verifying (UC-75)
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION }
 */
router.post("/:projectId/change-requests/:crId/clarify", authMiddleware, crController.clarify)
router.post("/:projectId/change-requests/:crId/answers", authMiddleware, crController.answers)
router.post("/:projectId/change-requests/:crId/impact", authMiddleware, crController.impact)
router.post("/:projectId/change-requests/:crId/propose", authMiddleware, crController.propose)
router.post("/:projectId/change-requests/:crId/verify", authMiddleware, crController.verify)
router.post("/:projectId/change-requests/:crId/submit", authMiddleware, crController.submit)
router.post("/:projectId/change-requests/:crId/revise", authMiddleware, crController.revise)
router.post("/:projectId/change-requests/:crId/resume", authMiddleware, crController.resume)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}/locations/{locId}:
 *   patch:
 *     summary: Sửa tay / kết luận tay một vị trí (UC-81, nút 3.9) ⇒ manual = true
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *       - { in: path, name: locId, required: true, schema: { type: string, example: L001 } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               conclusion: { type: string, enum: [edit, comment, not_related] }
 *               reason: { type: string }
 *               new_value: { description: "Giá trị mới của cả phần tử (JSON) ⇒ op set tại path của vị trí" }
 *               spine_ops: { type: array, items: { type: object } }
 *               comment_text: { type: string }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       404: { description: CR_LOCATION_NOT_FOUND }
 *       409: { description: CR_INVALID_TRANSITION, PATH_LOCKED }
 */
router.patch("/:projectId/change-requests/:crId/locations/:locId", authMiddleware, crController.updateLocation)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}/locations/{locId}/owner-step-draft:
 *   post:
 *     summary: "Sửa đề xuất trong step sở hữu (BPMN 3.9, mode 1 v3) — chạy skill của step sở hữu vị trí theo hướng của BA, chỉ ghi đề xuất (manual = true); kiểm lại bằng /verify"
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *       - { in: path, name: locId, required: true, schema: { type: string, example: L001 } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [instruction]
 *             properties:
 *               instruction: { type: string, example: "Giữ ngưỡng 1 giây nhưng thêm điều kiện 95% request" }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       402: { description: INSUFFICIENT_CREDIT }
 *       404: { description: CR_LOCATION_NOT_FOUND }
 *       409: { description: CR_INVALID_TRANSITION (CR không ở manual_fix), CR_NO_OWNER_STEP, PATH_LOCKED }
 *       502: { description: AI_PROVIDER_ERROR }
 */
router.post("/:projectId/change-requests/:crId/locations/:locId/owner-step-draft", authMiddleware, crController.ownerStepDraft)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}/groups/{gid}/decision:
 *   post:
 *     summary: Duyệt / từ chối một change group (UC-52, nút 3.12–3.14)
 *     description: |
 *       Group bị từ chối mở khoá ngay. Group cuối được quyết mà có group duyệt ⇒ ghi Track Changes + comment
 *       (author = mã CR) thành version minor mới, CR `written` kèm `result_doc_version`.
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *       - { in: path, name: gid, required: true, schema: { type: string, example: G01 } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision, base_version]
 *             properties:
 *               decision: { type: string, enum: [approved, rejected] }
 *               reason: { type: string, description: Bắt buộc ≥ 10 ký tự khi từ chối }
 *               base_version: { type: integer }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       404: { description: CR_GROUP_NOT_FOUND }
 *       409: { description: CR_INVALID_TRANSITION, CR_VALUE_CHANGED, SPINE_VERSION_CONFLICT }
 */
router.post("/:projectId/change-requests/:crId/groups/:gid/decision", authMiddleware, crController.decision)

/**
 * @swagger
 * /api/v1/projects/{projectId}/change-requests/{crId}/close:
 *   post:
 *     summary: Đóng CR sau khi mọi group bị từ chối (nút 3.13) ⇒ rejected
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [reason], properties: { reason: { type: string, minLength: 10 } } }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION }
 * /api/v1/projects/{projectId}/change-requests/{crId}/cancel:
 *   post:
 *     summary: Huỷ CR (UC-53, nút 3.10) ⇒ cancelled, mở khoá phần tử — được cả khi đang paused
 *     tags: [Change requests (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/Mode1ProjectId'
 *       - $ref: '#/components/parameters/CrId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [reason], properties: { reason: { type: string, minLength: 10 } } }
 *     responses:
 *       200: { $ref: '#/components/responses/CrDetail' }
 *       409: { description: CR_INVALID_TRANSITION }
 */
router.post("/:projectId/change-requests/:crId/close", authMiddleware, crController.close)
router.post("/:projectId/change-requests/:crId/cancel", authMiddleware, crController.cancel)

export default router
