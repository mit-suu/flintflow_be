import { Router } from "express"
import * as baselineController from "./baseline.controller.js"
import { authMiddleware } from "../../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/projects/{projectId}/baseline:
 *   post:
 *     summary: Ký baseline (S-9.5) — quét lại tất định rồi chụp snapshot Spine
 *     description: |
 *       Điều kiện duy nhất: **không còn cờ đỏ mở chưa waive** trên đúng `spine_version` đang ký.
 *       Không có ngưỡng phần trăm section. Thứ tự: quét lại (`atBaseline`) → kiểm cờ → ghi snapshot →
 *       thêm `baselines[]` và đánh dấu step S-9.5 accepted trong cùng một transaction.
 *       Có cờ được waive thì version mang hậu tố `-conditional`. Không gọi model, không trừ credit.
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
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT — base_version lệch, hoặc Spine đổi giữa lúc quét và lúc ký
 *       422:
 *         description: BASELINE_BLOCKED — còn cờ đỏ chưa waive, meta = { flags[] }
 */
router.post("/:projectId/baseline", authMiddleware, baselineController.createBaseline)

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
