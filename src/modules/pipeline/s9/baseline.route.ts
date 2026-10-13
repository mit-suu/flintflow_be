import { Router } from "express"
import * as baselineController from "./baseline.controller.js"
import { authMiddleware } from "../../../shared/auth/auth.middleware.js"
import { requireRole } from "../../../shared/auth/require-role.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/projects/{projectId}/baseline:
 *   post:
 *     summary: Duyệt và ký baseline (S-9.5, UC-46) — chỉ Lead
 *     description: |
 *       Điều kiện duy nhất: **không còn cờ đỏ mở** trên đúng `spine_version` đang ký — cờ đỏ đã waive
 *       vẫn chặn (BR-04). Không có ngưỡng phần trăm section. Thứ tự: quét lại (`atBaseline`) → kiểm cờ →
 *       ghi snapshot → thêm `baselines[]`, đánh dấu step S-9.5 accepted và xoá `baseline_submission`
 *       trong cùng một transaction.
 *       Dùng cho cả hai đường: duyệt bản Analyst đã nộp qua `/baseline/submit`, và Lead tự duyệt việc
 *       của chính mình khi chưa ai nộp. Không gọi model, không trừ credit.
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [base_version]
 *             properties:
 *               base_version:
 *                 type: integer
 *                 description: spine_version đã đọc từ GET /spine
 *     responses:
 *       201:
 *         description: "Baseline vừa ghi `{ id, version, at, snapshot_ref, checked_at_version, waived_count }`; meta = { spine_version, waived[] }"
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: ORG_ROLE_FORBIDDEN — chỉ Lead được duyệt
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT — base_version lệch, hoặc Spine đổi giữa lúc quét và lúc ký
 *       422:
 *         description: BASELINE_BLOCKED — còn cờ đỏ, meta = { flags[] }
 */
router.post("/:projectId/baseline", authMiddleware, requireRole("lead"), baselineController.createBaseline)

/**
 * @swagger
 * /api/v1/projects/{projectId}/baseline/submit:
 *   post:
 *     summary: Gửi Lead duyệt baseline (UC-45) — Analyst hoặc Lead
 *     description: |
 *       Đặt `baseline_submission` của Spine sang `pending`; **không** khoá baseline. Điều kiện giống
 *       hệt lượt duyệt (cờ đỏ = 0, BR-04) nên Analyst không nộp được bản mà Lead chắc chắn không ký
 *       được. Mọi Lead của org nhận notification `baseline_submitted`.
 *       Lượt nộp lại sau khi bị từ chối đòi mọi comment Lead đã ghim phải `resolved` hoặc `converted`.
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [base_version]
 *             properties:
 *               base_version:
 *                 type: integer
 *     responses:
 *       200:
 *         description: "`baseline_submission` vừa ghi; meta = { spine_version }"
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: ORG_ROLE_FORBIDDEN — Viewer không gửi duyệt được
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT · BASELINE_ALREADY_SUBMITTED — đang có bản chờ duyệt
 *       422:
 *         description: BASELINE_BLOCKED (meta = { flags[] }) · REJECTION_COMMENTS_OPEN (meta = { comment_ids[] })
 */
router.post("/:projectId/baseline/submit", authMiddleware, requireRole("lead", "analyst"), baselineController.submitBaseline)

/**
 * @swagger
 * /api/v1/projects/{projectId}/baseline/reject:
 *   post:
 *     summary: Từ chối baseline kèm lý do và comment ghim (UC-46 luồng thay thế) — chỉ Lead
 *     description: |
 *       Đặt `baseline_submission` sang `rejected` và ghi `reason` + `rejection_comment_ids`. Baseline
 *       không được ghi. `business-flow.md §3.5`: lý do **và** comment ghim đều bắt buộc — ghim trước
 *       qua `POST /projects/{projectId}/comments`, rồi Analyst xử lý từng comment (UC-47) và gửi
 *       lại qua `/baseline/submit`.
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [base_version, reason, comment_ids]
 *             properties:
 *               base_version:
 *                 type: integer
 *               reason:
 *                 type: string
 *                 maxLength: 2000
 *               comment_ids:
 *                 type: array
 *                 minItems: 1
 *                 items: { type: string, example: "CM-001" }
 *     responses:
 *       200:
 *         description: "`baseline_submission` đã chuyển `rejected`; meta = { spine_version }"
 *       400:
 *         description: VALIDATION_ERROR
 *       403:
 *         description: ORG_ROLE_FORBIDDEN — chỉ Lead được từ chối
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 *       422:
 *         description: NO_PENDING_SUBMISSION — không có bản nào đang chờ duyệt
 */
router.post("/:projectId/baseline/reject", authMiddleware, requireRole("lead"), baselineController.rejectBaseline)

/**
 * @swagger
 * /api/v1/projects/{projectId}/baselines:
 *   get:
 *     summary: Danh sách baseline đã ký của dự án
 *     description: |
 *       Bản sạch của một baseline đọc qua `GET /projects/{projectId}/document?source=baseline&baseline_id=<id>`
 *       (render từ snapshot, không đọc Spine sống).
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Baseline[] theo thứ tự ký
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 */
router.get("/:projectId/baselines", authMiddleware, baselineController.listBaselines)

export default router
