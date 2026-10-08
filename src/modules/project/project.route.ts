import { Router } from "express"
import multer from "multer"
import * as projectController from "./project.controller.js"
import * as chatSessionController from "./chat-session.controller.js"
import * as projectDocumentController from "./project-document.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import { CreateProjectSchema, MoveProjectSchema, UpdateDocumentLanguageSchema, validateRequest } from "./project.validation.js"

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
 *               folderId:
 *                 type: string
 *                 description: Tạo thẳng trong thư mục của user (404 FOLDER_NOT_FOUND nếu không thuộc user)
 *               mode:
 *                 type: string
 *                 enum: [import, fpt, customer_template]
 *                 default: fpt
 *                 description: "Cách làm SRS: import = upload SRS có sẵn rồi sửa (mode 1), fpt = sinh theo template FPT (mode 2), customer_template = chưa hỗ trợ"
 *               documentLanguage:
 *                 type: string
 *                 enum: [vi, en]
 *                 description: "Ngôn ngữ xem trước + .docx (FLF-265). Thiếu ⇒ ngôn ngữ tài khoản ⇒ en. Mode import bỏ qua — ngôn ngữ theo file upload"
 *     responses:
 *       201:
 *         description: Dự án đã được tạo thành công (kèm mode, import_state)
 *       400:
 *         description: VALIDATION_ERROR — tên trống/quá dài hoặc mode không hợp lệ
 *       402:
 *         description: PLAN_LIMIT_PROJECTS — tổ chức đã đủ số dự án tối đa của gói (dự án đã xoá không tính)
 *       403:
 *         description: ORG_ROLE_FORBIDDEN — Viewer không tạo dự án
 *       501:
 *         description: mode customer_template chưa hỗ trợ (NOT_IMPLEMENTED)
 *       401:
 *         description: Chưa xác thực
 */
router.get("/", authMiddleware, projectController.getProjects)
router.post("/", authMiddleware, validateRequest(CreateProjectSchema), projectController.createProject)

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
 *     summary: Lấy thông tin chi tiết một dự án (ghi lastOpenedAt — dùng cho sắp xếp "Mới mở")
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
 *         description: Nếu truyền true, xoá vĩnh viễn dự án cùng Spine, lịch sử thay đổi, baseline, usage, bản render, file sơ đồ, cuộc trò chuyện và tài liệu đính kèm (kể cả file trên Cloudinary). Mặc định chỉ lưu trữ (archived).
 *     responses:
 *       200:
 *         description: Xóa hoặc lưu trữ dự án thành công
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/name:
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
router.delete("/:projectId", authMiddleware, requireRole("lead"), projectController.deleteProject)
router.patch("/:projectId/name", authMiddleware, projectController.updateProjectName)

/**
 * @swagger
 * /api/v1/projects/{projectId}/folder:
 *   patch:
 *     summary: Chuyển dự án vào thư mục (folderId null ⇒ ra ngoài thư mục)
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [folderId]
 *             properties:
 *               folderId:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Dự án sau khi chuyển
 *       404:
 *         description: PROJECT_NOT_FOUND hoặc FOLDER_NOT_FOUND (không thuộc user)
 */
router.patch("/:projectId/folder", authMiddleware, validateRequest(MoveProjectSchema), projectController.moveProjectToFolder)

/**
 * @swagger
 * /api/v1/projects/{projectId}/document-language:
 *   patch:
 *     summary: Đổi ngôn ngữ tài liệu (xem trước + .docx) của dự án — không đổi Spine, nội dung đã có dịch ở bước sau
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [documentLanguage]
 *             additionalProperties: false
 *             properties:
 *               documentLanguage:
 *                 type: string
 *                 enum: [vi, en]
 *     responses:
 *       200:
 *         description: Dự án sau khi đổi (kèm documentLanguage)
 *       400:
 *         description: VALIDATION_ERROR — giá trị ngoài vi/en hoặc có key lạ
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không đổi được)
 *       404:
 *         description: PROJECT_NOT_FOUND (không thuộc tổ chức)
 *       409:
 *         description: DOCUMENT_LANGUAGE_LOCKED — dự án mode import dùng ngôn ngữ của file upload
 */
router.patch(
  "/:projectId/document-language",
  authMiddleware,
  requireRole("lead", "analyst"),
  validateRequest(UpdateDocumentLanguageSchema),
  projectController.setDocumentLanguage
)

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
 *         description: Danh sách cuộc trò chuyện — mỗi phiên chỉ kèm tin cuối (lịch sử đầy đủ ở GET /chats/{chatId})
 *       401:
 *         description: Chưa xác thực
 *   post:
 *     summary: Tạo cuộc trò chuyện mới. Phiên đầu tiên của dự án là phiên chính (is_pipeline) chạy quy trình; các phiên sau chỉ hỏi đáp và nhận lệnh sửa
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
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không tạo phiên)
 */
router.get("/:projectId/chats", authMiddleware, chatSessionController.getChatSessions)
router.post("/:projectId/chats", authMiddleware, requireRole("lead", "analyst"), chatSessionController.createChatSession)

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
 *     summary: Xóa một cuộc trò chuyện phụ (phiên chính không xoá được)
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
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không xoá phiên)
 *       404:
 *         description: Không tìm thấy cuộc trò chuyện
 *       409:
 *         description: PIPELINE_SESSION_LOCKED — phiên chính (is_pipeline) không xoá được
 */
router.get("/:projectId/chats/:chatId", authMiddleware, chatSessionController.getChatSession)
router.delete("/:projectId/chats/:chatId", authMiddleware, requireRole("lead", "analyst"), chatSessionController.deleteChatSession)

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
 *                 description: Step id theo step registry (vd B-1.1, S-3.2) — chỉ là nhãn lưu vào transcript
 *                 example: B-1.1
 *     responses:
 *       200:
 *         description: Trả về cuộc trò chuyện được cập nhật tin nhắn và phản hồi từ AI
 *       400:
 *         description: Thiếu thông tin
 *       401:
 *         description: Chưa xác thực
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không gửi tin — gọi AI tốn credit)
 */
router.post("/:projectId/chats/:chatId/messages", authMiddleware, requireRole("lead", "analyst"), chatSessionController.sendMessage)
router.post("/:projectId/chats/:chatId/messages/stream", authMiddleware, requireRole("lead", "analyst"), chatSessionController.sendMessageStream)

export default router
