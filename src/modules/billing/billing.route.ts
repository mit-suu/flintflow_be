import { Router } from "express"
import * as billingController from "./billing.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
// Flow 10.4 — gắn từng route: payment-callback là webhook không token, không được chặn.
import { requireActiveAccount } from "../../shared/auth/account-guard.middleware.js"
import { orgContext } from "../../shared/auth/org-context.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import { checkoutSchema, paymentCallbackSchema, upgradeSchema, validateBody } from "./billing.validation.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: Số dư credit, gói nạp, thanh toán VietQR qua payment_service dùng chung
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
router.get("/balance", authMiddleware, requireActiveAccount, orgContext, requireRole("lead", "analyst"), billingController.getBalance)

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
router.get("/packages", authMiddleware, requireActiveAccount, billingController.getPackages)

/**
 * @swagger
 * /api/v1/billing/checkout:
 *   post:
 *     summary: Tạo PaymentIntent và order trên payment_service, trả về mã VietQR
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
 *         description: "{ intentId, packageId, credits, amount, currency, status, referenceCode, paymentDescription, qrCodeUrl }"
 *       400:
 *         description: Thiếu packageId
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Gói không tồn tại
 *       502:
 *         description: payment_service lỗi hoặc không kết nối được
 *       503:
 *         description: Chưa cấu hình PAYMENT_SERVICE_URL / PAYMENT_CLIENT_ID / PAYMENT_API_KEY
 */
router.post("/checkout", authMiddleware, requireActiveAccount, orgContext, requireRole("lead"), validateBody(checkoutSchema), billingController.createCheckout)

/**
 * @swagger
 * /api/v1/billing/checkout/{intentId}:
 *   get:
 *     summary: Trạng thái giao dịch (FE polling); còn pending thì đối chiếu với payment_service
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
 *         description: PaymentIntent (status pending | succeeded | failed)
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy giao dịch của người dùng
 */
router.get("/checkout/:intentId", authMiddleware, requireActiveAccount, orgContext, requireRole("lead"), billingController.getCheckout)

/**
 * @swagger
 * /api/v1/billing/payment-callback:
 *   post:
 *     summary: Callback từ payment_service khi order đổi trạng thái
 *     description: |
 *       Không dùng JWT (payment_service gọi server-to-server). Callback chưa được ký,
 *       nên BE kiểm `client_id` rồi xác minh lại bằng `GET /api/orders/{order_id}`
 *       trước khi cộng credit. Idempotent theo order_id.
 *     tags: [Billing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_id, status, client_id]
 *             properties:
 *               order_id:
 *                 type: string
 *               status:
 *                 type: string
 *                 example: paid
 *               client_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ success: true, status, alreadyProcessed, creditsAdded }"
 *       400:
 *         description: Payload không hợp lệ
 *       403:
 *         description: client_id không khớp
 *       404:
 *         description: Không tìm thấy giao dịch
 *       502:
 *         description: Không xác minh được với payment_service (có thể gọi lại)
 */
router.post("/payment-callback", validateBody(paymentCallbackSchema), billingController.paymentCallback)

/**
 * @swagger
 * /api/v1/billing/upgrade:
 *   post:
 *     summary: Về gói miễn phí — gói trả phí trả 402 PAYMENT_REQUIRED, mua qua POST /billing/checkout với packageId "plan:<id>"
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
router.post("/upgrade", authMiddleware, requireActiveAccount, orgContext, requireRole("lead"), validateBody(upgradeSchema), billingController.upgradePlan)

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
router.get("/transactions", authMiddleware, requireActiveAccount, orgContext, requireRole("lead", "analyst"), billingController.getTransactions)

export default router
