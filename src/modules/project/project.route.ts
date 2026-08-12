import { Router } from "express"
import multer from "multer"
import * as projectController from "./project.controller.js"
import * as chatSessionController from "./chat-session.controller.js"
import * as projectDocumentController from "./project-document.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
})

/**
 * @swagger
 * tags:
 *   name: Projects
 *   description: Quản lý dự án của người dùng
 */

/**
 * @swagger
 * tags:
 *   name: Chat Sessions
 *   description: Quản lý các phiên trò chuyện (chat sessions) của dự án
 */

/**
 * @swagger
 * /api/v1/projects:
 *   get:
 *     summary: Lấy danh sách dự án của người dùng hiện tại
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, archived]
 *         description: Lọc dự án theo trạng thái (mặc định trả tất cả)
 *     responses:
 *       200:
 *         description: Trả về danh sách các dự án
 *       401:
 *         description: Chưa xác thực
 *   post:
 *     summary: Tạo một dự án mới
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Lumen — SaaS quản lý khoá học
 *               domain:
 *                 type: string
 *                 example: E-learning
 *     responses:
 *       201:
 *         description: Dự án đã được tạo thành công
 *       400:
 *         description: Tên dự án trống
 *       401:
 *         description: Chưa xác thực
 */
router.get("/", authMiddleware, projectController.getProjects)
router.post("/", authMiddleware, projectController.createProject)

/**
 * @swagger
 * /api/v1/projects/{projectId}/documents:
 *   get:
 *     summary: Lấy danh sách tài liệu đính kèm của dự án
 *     tags: [Projects]
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
 *         description: Danh sách tài liệu
 *       401:
 *         description: Chưa xác thực
 *   post:
 *     summary: Upload tài liệu đính kèm cho dự án
 *     tags: [Projects]
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Upload thành công
 *       400:
 *         description: File không hợp lệ
 *       401:
 *         description: Chưa xác thực
 */
router.get("/:projectId/documents", authMiddleware, projectDocumentController.getDocuments)
router.post(
  "/:projectId/documents",
  authMiddleware,
  upload.single("file"),
  projectDocumentController.uploadDocument
)

/**
 * @swagger
 * /api/v1/projects/{projectId}/documents/{documentId}:
 *   delete:
 *     summary: Xóa tài liệu đính kèm khỏi dự án
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Xóa thành công
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy tài liệu
 */
router.delete(
  "/:projectId/documents/:documentId",
  authMiddleware,
  projectDocumentController.deleteDocument
)

/**
 * @swagger
 * /api/v1/projects/{projectId}:
 *   get:
 *     summary: Lấy thông tin chi tiết một dự án
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     responses:
 *       200:
 *         description: Thông tin dự án
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 *   delete:
 *     summary: Xóa (lưu trữ hoặc xóa vĩnh viễn) một dự án
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án cần xóa
 *       - in: query
 *         name: hard
 *         schema:
 *           type: boolean
 *         description: Nếu truyền true, dự án và tất cả cuộc trò chuyện, tài liệu đính kèm sẽ bị xoá vĩnh viễn khỏi DB.
 *     responses:
 *       200:
 *         description: Xóa hoặc lưu trữ dự án thành công
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 *   patch:
 *     summary: Đổi tên một dự án
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án cần đổi tên
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Tên mới của dự án
 *     responses:
 *       200:
 *         description: Đổi tên thành công
 *       400:
 *         description: Thiếu tên mới hoặc tên trống
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 */
router.get("/:projectId", authMiddleware, projectController.getProject)
router.delete("/:projectId", authMiddleware, projectController.deleteProject)
router.patch("/:projectId/name", authMiddleware, projectController.updateProjectName)

/**
 * @swagger
 * /api/v1/projects/{projectId}/chats:
 *   get:
 *     summary: Lấy danh sách các cuộc trò chuyện của dự án
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     responses:
 *       200:
 *         description: Danh sách cuộc trò chuyện
 *       401:
 *         description: Chưa xác thực
 *   post:
 *     summary: Tạo cuộc trò chuyện mới trong dự án (tự động tắt kích hoạt các cuộc trò chuyện cũ)
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     responses:
 *       201:
 *         description: Tạo thành công
 *       401:
 *         description: Chưa xác thực
 */
router.get("/:projectId/chats", authMiddleware, chatSessionController.getChatSessions)
router.post("/:projectId/chats", authMiddleware, chatSessionController.createChatSession)

/**
 * @swagger
 * /api/v1/projects/{projectId}/chats/{chatId}:
 *   get:
 *     summary: Lấy thông tin chi tiết (lịch sử tin nhắn) của một cuộc trò chuyện
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của cuộc trò chuyện
 *     responses:
 *       200:
 *         description: Chi tiết cuộc trò chuyện kèm tin nhắn
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy cuộc trò chuyện
 *   delete:
 *     summary: Xóa một cuộc trò chuyện
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của cuộc trò chuyện
 *     responses:
 *       200:
 *         description: Xóa thành công
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy cuộc trò chuyện
 */
router.get("/:projectId/chats/:chatId", authMiddleware, chatSessionController.getChatSession)
router.delete("/:projectId/chats/:chatId", authMiddleware, chatSessionController.deleteChatSession)

/**
 * @swagger
 * /api/v1/projects/{projectId}/chats/{chatId}/messages:
 *   post:
 *     summary: Gửi một tin nhắn vào cuộc trò chuyện và lấy phản hồi của BA AI
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của cuộc trò chuyện
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content, step]
 *             properties:
 *               content:
 *                 type: string
 *                 example: Tôi muốn làm SaaS bán khóa học
 *               step:
 *                 type: string
 *                 enum: [vision_problem, target_users, value_proposition, mvp_scope]
 *                 example: vision_problem
 *     responses:
 *       200:
 *         description: Trả về cuộc trò chuyện được cập nhật tin nhắn và phản hồi từ AI
 *       400:
 *         description: Thiếu thông tin
 *       401:
 *         description: Chưa xác thực
 */
router.post("/:projectId/chats/:chatId/messages", authMiddleware, chatSessionController.sendMessage)

export default router
