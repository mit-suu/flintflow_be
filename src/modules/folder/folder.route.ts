import { Router } from "express"
import * as folderController from "./folder.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { validateRequest } from "../project/project.validation.js"
import { CreateFolderSchema, UpdateFolderSchema } from "./folder.validation.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Folders
 *   description: Thư mục nhóm dự án của người dùng
 */

/**
 * @swagger
 * /api/v1/folders:
 *   get:
 *     summary: Danh sách thư mục của user (mới nhất trước), kèm projectCount — số dự án đang làm bên trong
 *     tags: [Folders]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách thư mục
 *       401:
 *         description: Chưa xác thực
 *   post:
 *     summary: Tạo thư mục
 *     tags: [Folders]
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
 *                 maxLength: 60
 *               color:
 *                 type: string
 *                 enum: [violet, blue, amber, green, rose]
 *     responses:
 *       201:
 *         description: Đã tạo
 *       400:
 *         description: VALIDATION_ERROR
 */
router.get("/", authMiddleware, folderController.listFolders)
router.post("/", authMiddleware, validateRequest(CreateFolderSchema), folderController.createFolder)

/**
 * @swagger
 * /api/v1/folders/{folderId}:
 *   patch:
 *     summary: Đổi tên / màu thư mục
 *     tags: [Folders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               color:
 *                 type: string
 *                 enum: [violet, blue, amber, green, rose]
 *     responses:
 *       200:
 *         description: Đã cập nhật
 *       404:
 *         description: FOLDER_NOT_FOUND
 *   delete:
 *     summary: Xoá thư mục — dự án bên trong được giữ, chuyển ra ngoài thư mục
 *     tags: [Folders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "{ _id, releasedProjects }"
 *       404:
 *         description: FOLDER_NOT_FOUND
 */
router.patch("/:folderId", authMiddleware, validateRequest(UpdateFolderSchema), folderController.updateFolder)
router.delete("/:folderId", authMiddleware, folderController.deleteFolder)

export default router
