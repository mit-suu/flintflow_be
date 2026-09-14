import { Router } from "express"
import * as billingController from "./billing.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { checkoutSchema, mockWebhookSchema, upgradeSchema, validateBody } from "./billing.validation.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: Số dư credit, gói nạp, thanh toán qua cổng mock (Phases §9.2)
 */

/**
 * @swagger
 * /api/v1/billing/balance:
 *   get:
 *     summary: Số dư, credit đang giữ, gói hiện tại và 20 dòng ledger gần nhất
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ balance, reserved, available, plan, planLabel, lowCreditThreshold, subscription, ledger[] }"
 *       401:
 *         description: Chưa xác thực
 */
router.get("/balance", authMiddleware, billingController.getBalance)

/**
 * @swagger
 * /api/v1/billing/packages:
 *   get:
 *     summary: Danh sách gói nạp credit và gói subscription
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ packages[], plans[] }"
 *       401:
 *         description: Chưa xác thực
 */
router.get("/packages", authMiddleware, billingController.getPackages)

/**
 * @swagger
 * /api/v1/billing/checkout:
 *   post:
 *     summary: Tạo PaymentIntent (pending) và trả về redirectUrl tới trang mock checkout
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [packageId]
 *             properties:
 *               packageId:
 *                 type: string
 *                 example: pack_100
 *     responses:
 *       201:
 *         description: "{ intentId, packageId, credits, amount, currency, status, redirectUrl }"
 *       400:
 *         description: Thiếu packageId
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Gói không tồn tại
 */
router.post("/checkout", authMiddleware, validateBody(checkoutSchema), billingController.createCheckout)

/**
 * @swagger
 * /api/v1/billing/checkout/{intentId}:
 *   get:
 *     summary: Chi tiết PaymentIntent cho trang mock checkout (kèm chữ ký giả lập khi còn pending)
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: intentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "{ intentId, credits, amount, status, mockSignatures: { success, failed } | null }"
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy giao dịch của người dùng
 */
router.get("/checkout/:intentId", authMiddleware, billingController.getCheckout)

/**
 * @swagger
 * /api/v1/billing/webhook/mock:
 *   post:
 *     summary: Webhook của cổng thanh toán mock (ký HMAC-SHA256, idempotent theo intentId)
 *     description: |
 *       Chữ ký = HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, "<intentId>.<status>") dạng hex,
 *       gửi qua header `x-mock-signature` (hoặc field `signature` trong body).
 *       Gửi lại cùng intentId không cộng credit lần hai (`alreadyProcessed: true`).
 *     tags: [Billing]
 *     parameters:
 *       - in: header
 *         name: x-mock-signature
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [intentId, status]
 *             properties:
 *               intentId:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [success, failed]
 *               signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ intentId, status, alreadyProcessed, creditsAdded, balance? }"
 *       400:
 *         description: Payload không hợp lệ
 *       401:
 *         description: Chữ ký sai hoặc thiếu
 *       404:
 *         description: Không tìm thấy giao dịch
 */
router.post("/webhook/mock", validateBody(mockWebhookSchema), billingController.mockWebhook)

/**
 * @swagger
 * /api/v1/billing/upgrade:
 *   post:
 *     summary: Đổi gói subscription (mock, chưa thu tiền) — ghi Subscription
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan]
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [free, pro]
 *     responses:
 *       200:
 *         description: Subscription sau khi cập nhật
 *       400:
 *         description: Gói không hợp lệ
 *       401:
 *         description: Chưa xác thực
 */
router.post("/upgrade", authMiddleware, validateBody(upgradeSchema), billingController.upgradePlan)

/**
 * @swagger
 * /api/v1/billing/transactions:
 *   get:
 *     summary: Lịch sử giao dịch credit (phân trang)
 *     tags: [Billing]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Danh sách CreditTransaction; meta gồm page, limit, total, totalPages
 *       401:
 *         description: Chưa xác thực
 */
router.get("/transactions", authMiddleware, billingController.getTransactions)

export default router
