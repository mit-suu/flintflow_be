import { Router, type NextFunction, type Request, type Response } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import * as googleController from "./google.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { validateRequest } from "../project/project.validation.js"
import { ConnectGoogleSchema } from "./google.validation.js"

const router = Router()

/**
 * `authMiddleware` nhận cả cookie `accessToken` và production đặt `SameSite=none`, còn app bật `express.urlencoded`.
 * Không chặn thì một trang lạ gửi form `code=<mã của kẻ xấu>` kèm cookie của nạn nhân là gắn được Drive của kẻ xấu vào
 * tài khoản nạn nhân, và các lần xuất sau chạy sang Drive đó. Body JSON từ trang khác site phải qua preflight CORS.
 */
const requireJsonBody = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.is("application/json")) {
    throw new ApiError(415, "Yêu cầu phải gửi dữ liệu dạng JSON.", "UNSUPPORTED_MEDIA_TYPE")
  }
  next()
}

/**
 * @swagger
 * tags:
 *   name: Google integration
 *   description: Kết nối tài khoản Google (quyền drive.file) cho xuất / nhập Google Docs. Thiếu cấu hình ⇒ 503 GOOGLE_INTEGRATION_DISABLED
 */

/**
 * @swagger
 * /api/v1/integrations/google/connect:
 *   post:
 *     summary: Đổi mã uỷ quyền (popup auth-code) lấy refresh token, lưu đã mã hoá
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ status: connected, email, connectedAt }"
 *       400:
 *         description: GOOGLE_CONSENT_INCOMPLETE — thiếu quyền drive.file / refresh token, hoặc mã sai
 *       415:
 *         description: UNSUPPORTED_MEDIA_TYPE — body không phải application/json
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.post("/connect", authMiddleware, requireJsonBody, validateRequest(ConnectGoogleSchema), googleController.connect)

/**
 * @swagger
 * /api/v1/integrations/google/status:
 *   get:
 *     summary: Trạng thái kết nối Google của user hiện tại
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ status: connected | disconnected | reconnect_required, email, connectedAt }"
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.get("/status", authMiddleware, googleController.getStatus)

/**
 * @swagger
 * /api/v1/integrations/google/access-token:
 *   get:
 *     summary: Access token ngắn hạn cho Google Picker (không bao giờ trả refresh token)
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ accessToken, expiresAt }"
 *       401:
 *         description: GOOGLE_RECONNECT_REQUIRED — chưa nối, hoặc Google đã thu hồi / hết hạn quyền
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.get("/access-token", authMiddleware, googleController.getAccessToken)

/**
 * @swagger
 * /api/v1/integrations/google:
 *   delete:
 *     summary: Ngắt kết nối — thu hồi quyền phía Google (bỏ qua lỗi) và xoá token đã lưu
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ status: disconnected, email: null, connectedAt: null }"
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.delete("/", authMiddleware, googleController.disconnect)

export default router
