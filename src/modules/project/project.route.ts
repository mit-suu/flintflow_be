import { Router } from "express"
import multer from "multer"
import * as projectController from "./project.controller.js"
import * as chatSessionController from "./chat-session.controller.js"
import * as projectDocumentController from "./project-document.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import { receiveDocx } from "../import/import.controller.js"
import { CreateProjectSchema, MoveProjectSchema, UpdateDocumentLanguageSchema, UpdateErdNotationSchema, UpdateScreenThemeSchema, RunScreenMockupsSchema, DisableScreenMockupsSchema, validateRequest } from "./project.validation.js"

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
 *               has_srs_file:
 *                 type: boolean
 *                 description: "Hộp Tạo dự án hai ô: có tải file SRS không. Có trường này thì source / has_required_template / mode bị bỏ qua (false ⇒ fpt; true ⇒ import, start_kind=existing)"
 *               complete_to_standard:
 *                 type: boolean
 *                 description: "Chỉ khi has_srs_file=true: tick \"Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow\" ⇒ template_intent=free; không gửi / false ⇒ fixed (giữ khung file)"
 *               source:
 *                 type: string
 *                 enum: [new, existing]
 *                 description: "FLF-335: dự án mới / dự án có sẵn — BE suy ra mode (mới không mẫu ⇒ fpt; mới có mẫu bắt buộc hoặc có sẵn ⇒ import)"
 *               has_required_template:
 *                 type: boolean
 *                 description: "Chỉ với source=new: khách có bắt buộc theo một mẫu không (có ⇒ import, template_intent=fixed)"
 *               mode:
 *                 type: string
 *                 enum: [import, fpt, customer_template]
 *                 default: fpt
 *                 description: "Client cũ: cách làm SRS gửi thẳng; có source thì bỏ qua. customer_template quy về import + mẫu bắt buộc"
 *               documentLanguage:
 *                 type: string
 *                 enum: [vi, en]
 *                 description: "Ngôn ngữ xem trước + .docx (FLF-265). Thiếu ⇒ ngôn ngữ tài khoản ⇒ en. Mode import bỏ qua — ngôn ngữ theo file upload"
 *     responses:
 *       201:
 *         description: Dự án đã được tạo thành công (kèm mode, start_kind, has_required_template, template_intent, import_state)
 *       400:
 *         description: VALIDATION_ERROR — tên trống/quá dài hoặc mode không hợp lệ
 *       402:
 *         description: PLAN_LIMIT_PROJECTS — tổ chức đã đủ số dự án tối đa của gói (dự án đã xoá không tính)
 *       403:
 *         description: ORG_ROLE_FORBIDDEN — Viewer không tạo dự án
 *       401:
 *         description: Chưa xác thực
 */
router.get("/", authMiddleware, projectController.getProjects)
router.post("/", authMiddleware, validateRequest(CreateProjectSchema), projectController.createProject)

/**
 * @swagger
 * /api/v1/projects/precheck-docx:
 *   post:
 *     summary: "Kiểm file có trông như SRS không (business-flow §3.6) — hộp Tạo dự án, ô Tài liệu tham khảo"
 *     description: >
 *       Code nhận diện như preflight I-1 (dấu version FlintFlow + loại tài liệu), không gọi AI, không lưu file. Chỉ .docx;
 *       định dạng khác ⇒ `looks_like_srs: false`, `srs_suggestion: "none"`. Giới hạn kích thước như upload SRS. FLF-409:
 *       `srs_suggestion` `strong` (dấu version / tiêu đề SRS / đủ hình thức SRS) ⇒ hỏi chuyển sang ô SRS, `possible` ⇒ nhắc nhẹ,
 *       `none` ⇒ không gợi ý; `looks_like_srs` = `strong`.
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: "`{ looks_like_srs: boolean, srs_suggestion: strong | possible | none, stamp: { project_id } | null }`"
 *       400: { description: FILE_REQUIRED }
 *       413: { description: FILE_TOO_LARGE }
 */
router.post("/precheck-docx", authMiddleware, requireRole("lead", "analyst"), receiveDocx, projectDocumentController.precheckDocument)

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
 *         description: >
 *           Danh sách tài liệu đang dùng (FLF-398: bản đã bị thay không trả); mỗi bản kèm `replaces: [{ id, name, doc_code }]`
 *           — các bản cũ nó đã thay
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
 *               replace_document_id:
 *                 type: string
 *                 description: "FLF-398 — \"Thay bản cũ\": id tài liệu đang dùng mà file này thay (bản cũ thành `supersededBy`)"
 *               keep_both:
 *                 type: string
 *                 enum: ["true"]
 *                 description: "FLF-398 — \"Giữ cả hai\": không hỏi bản mới nữa (trùng hệt vẫn chặn)"
 *     responses:
 *       201:
 *         description: "Upload thành công - tài liệu kèm `precheck { looks_like_srs, srs_suggestion, stamp, heading_overlap? }` (business-flow §3.6; `null` nếu kiểm lỗi)"
 *       400:
 *         description: File không hợp lệ
 *       404:
 *         description: "`DOCUMENT_NOT_FOUND` — `replace_document_id` không thuộc dự án"
 *       409:
 *         description: >
 *           FLF-398 — `DUPLICATE_DOCUMENT` (trùng hệt nội dung, `meta { document, superseded_by? }`, không lưu, không tóm tắt);
 *           `POSSIBLE_NEW_VERSION` (cùng tên gốc / nội dung giống ≥ 70%, `meta { candidates: [{ id, name, doc_code, reason, similarity }] }`
 *           — gửi lại kèm `replace_document_id` hoặc `keep_both`); `DOCUMENT_ALREADY_SUPERSEDED`
 *       401:
 *         description: Chưa xác thực
 */
router.get("/:projectId/documents", authMiddleware, projectDocumentController.getDocuments)

/**
 * @swagger
 * /api/v1/projects/{projectId}/sources:
 *   get:
 *     summary: Nguồn tài liệu của từng yêu cầu (FLF-292) — phần tử Spine nào được viết từ đoạn nào của tài liệu upload
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
 *         description: >
 *           `{ sources: [{ path, step_id, updated_at, refs: [{ para_id, document_id, document_name, quote }] }] }` —
 *           `path` như `functions[id=FN12]`; `para_id` như `D1-P03`; tài liệu đã xoá ⇒ `document_name: null`, `quote` vẫn còn
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 */
router.get("/:projectId/sources", authMiddleware, projectDocumentController.getSources)
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
 * /api/v1/projects/{projectId}/erd-notation:
 *   patch:
 *     summary: Đổi ký pháp ERD (§3.1.5) của dự án — không đổi Spine; ERD đã vẽ được vẽ lại bằng ký pháp mới
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
 *             required: [erdNotation]
 *             additionalProperties: false
 *             properties:
 *               erdNotation:
 *                 type: string
 *                 enum: [chen, crowsfoot, idef1x]
 *     responses:
 *       200:
 *         description: Dự án sau khi đổi (kèm erdNotation)
 *       400:
 *         description: VALIDATION_ERROR — giá trị ngoài chen/crowsfoot/idef1x hoặc có key lạ
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không đổi được)
 *       404:
 *         description: PROJECT_NOT_FOUND (không thuộc tổ chức)
 */
router.patch(
  "/:projectId/erd-notation",
  authMiddleware,
  requireRole("lead", "analyst"),
  validateRequest(UpdateErdNotationSchema),
  projectController.setErdNotation
)

/**
 * @swagger
 * /api/v1/projects/{projectId}/screen-theme:
 *   patch:
 *     summary: Đổi theme mockup màn §3.x.y (màu chính, domain, nền tảng) — không đổi Spine; mockup đã vẽ được vẽ lại bằng spec đã lưu, không gọi AI
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
 *             additionalProperties: false
 *             minProperties: 1
 *             properties:
 *               primaryColor:
 *                 type: string
 *                 nullable: true
 *                 pattern: '^#[0-9A-Fa-f]{6}$'
 *               domain:
 *                 type: string
 *                 nullable: true
 *                 description: Hostname hoặc URL (được chuẩn hoá thành hostname); rỗng / null ⇒ thanh địa chỉ chỉ hiện đường dẫn
 *               platforms:
 *                 type: array
 *                 nullable: true
 *                 minItems: 1
 *                 items:
 *                   type: string
 *                   enum: [web, mobile]
 *     responses:
 *       200:
 *         description: Dự án sau khi đổi (kèm screenTheme)
 *       400:
 *         description: VALIDATION_ERROR — màu không phải #RRGGBB, domain sai, nền tảng rỗng / trùng, key lạ hoặc body rỗng
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không đổi được)
 *       404:
 *         description: PROJECT_NOT_FOUND (không thuộc tổ chức)
 */
router.patch(
  "/:projectId/screen-theme",
  authMiddleware,
  requireRole("lead", "analyst"),
  validateRequest(UpdateScreenThemeSchema),
  projectController.setScreenTheme
)

/**
 * @swagger
 * /api/v1/projects/{projectId}/screen-mockups:
 *   get:
 *     summary: Dự án import - tóm tắt màn có ảnh gốc / đang dùng mockup; có `mode` ⇒ ước tính credit vẽ lại (không gọi AI)
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: query, name: mode, schema: { type: string, enum: [system, original] } }
 *       - { in: query, name: scope, schema: { type: string, enum: [screen, all] } }
 *       - { in: query, name: screen_id, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "Không mode: { with_original, using_mockup, screens[], originals[{ screen_id, section_id, name }] }. Có mode: { screens, ai_calls, credits, reenable, groups: { draw[], reenable[], skip[] } } (màn đã đúng kiểu, spec còn khớp ⇒ không tính)"
 *       400:
 *         description: VALIDATION_ERROR | SCREEN_HAS_NO_ORIGINAL
 *       404:
 *         description: PROJECT_NOT_FOUND | SCREEN_NOT_FOUND
 *   post:
 *     summary: Vẽ lại ảnh gốc màn bằng mockup (kiểu chuẩn / theo bố cục ảnh gốc) - một màn hoặc mọi màn có ảnh gốc; kiểm credit trước khi chạy
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [mode, scope]
 *             properties:
 *               mode: { type: string, enum: [system, original] }
 *               scope: { type: string, enum: [screen, all] }
 *               screen_id: { type: string, description: "Một màn (scope = screen)" }
 *               screen_ids: { type: array, items: { type: string }, description: "Nhiều màn một lượt (scope = screen), vd thử lại các màn lỗi" }
 *     responses:
 *       202:
 *         description: "Lượt vẽ chạy nền đã bắt đầu - tiến độ ban đầu như GET …/screen-mockups/run"
 *       409:
 *         description: SCREEN_MOCKUP_RUNNING - dự án đang có lượt chạy
 *       400:
 *         description: VALIDATION_ERROR | SCREEN_HAS_NO_ORIGINAL
 *       402:
 *         description: INSUFFICIENT_CREDITS - meta { required, available }, không màn nào được vẽ
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer)
 *       404:
 *         description: PROJECT_NOT_FOUND | SCREEN_NOT_FOUND
 *       503:
 *         description: SCREEN_MOCKUP_QUEUE_UNAVAILABLE - hàng đợi nền không phản hồi, lượt bị huỷ, không màn nào đổi
 *   delete:
 *     summary: Dùng lại ảnh gốc cho một màn / mọi màn (giữ hình mockup đã vẽ để bật lại không tốn credit)
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [scope]
 *             properties:
 *               scope: { type: string, enum: [screen, all] }
 *               screen_id: { type: string }
 *     responses:
 *       200:
 *         description: "{ disabled[] }"
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer)
 */
router.get("/:projectId/screen-mockups", authMiddleware, projectController.screenMockupsInfo)
/**
 * @swagger
 * /api/v1/projects/{projectId}/screen-mockups/run:
 *   get:
 *     summary: Tiến độ lượt vẽ lại mockup gần nhất (chạy nền); chưa từng chạy ⇒ data null
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ run_id, status: running|done|cancelled|interrupted, stopping, total, completed, done[], failed[], fell_back_to_system[], pending[], suggested_color }"
 * /api/v1/projects/{projectId}/screen-mockups/run/cancel:
 *   post:
 *     summary: Dừng lượt đang chạy - màn đang vẽ vẽ nốt, các màn còn lại không vẽ, không trừ credit
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Tiến độ sau khi yêu cầu dừng (stopping = true)
 */
router.get("/:projectId/screen-mockups/run", authMiddleware, projectController.screenMockupRun)
/**
 * @swagger
 * /api/v1/projects/{projectId}/screen-mockups/{screenId}/original:
 *   get:
 *     summary: Ảnh gốc của màn (PNG / JPEG, file import) - hình minh hoạ cho kiểu "Theo bố cục ảnh gốc"
 *     tags: [Projects]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: screenId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Ảnh (image/png | image/jpeg)
 *       404:
 *         description: SCREEN_HAS_NO_ORIGINAL - không có ảnh / ảnh không nhúng được (EMF)
 */
router.get("/:projectId/screen-mockups/:screenId/original", authMiddleware, projectController.screenOriginalImage)
router.post("/:projectId/screen-mockups/run/cancel", authMiddleware, requireRole("lead", "analyst"), projectController.cancelScreenMockupRun)
router.post("/:projectId/screen-mockups", authMiddleware, requireRole("lead", "analyst"), validateRequest(RunScreenMockupsSchema), projectController.runScreenMockups)
router.delete("/:projectId/screen-mockups", authMiddleware, requireRole("lead", "analyst"), validateRequest(DisableScreenMockupsSchema), projectController.disableScreenMockups)

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
 *               knowledge:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   FLF-267 — câu hỏi tri thức: trả lời từ Knowledge RAG (call_kind knowledge_answer, 2 credit) thay cho CHAT,
 *                   đi trước lượt chờ của step và lệnh sửa. Tin AI ghi vào phiên = { reply, questions: [], grounded, citations[] };
 *                   grounded=false ⇒ câu "không đủ căn cứ" (không gọi model khi truy hồi không đủ gần). Xem pipeline-contract §1.2.
 *     responses:
 *       200:
 *         description: Trả về cuộc trò chuyện được cập nhật tin nhắn và phản hồi từ AI
 *       400:
 *         description: Thiếu thông tin; VALIDATION_ERROR khi knowledge không phải boolean
 *       401:
 *         description: Chưa xác thực
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer không gửi tin — gọi AI tốn credit)
 *       409:
 *         description: KNOWLEDGE_DISABLED — gửi knowledge=true khi server tắt Knowledge RAG (KNOWLEDGE_ENABLED=false)
 */
router.post("/:projectId/chats/:chatId/messages", authMiddleware, requireRole("lead", "analyst"), chatSessionController.sendMessage)
/**
 * @swagger
 * /api/v1/projects/{projectId}/chats/{chatId}/messages/stream:
 *   post:
 *     summary: Như /messages nhưng trả SSE (text-delta… rồi finish); knowledge=true ⇒ chỉ một sự kiện finish
 *     tags: [Chat Sessions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
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
 *               step:
 *                 type: string
 *               knowledge:
 *                 type: boolean
 *                 default: false
 *                 description: FLF-267 — câu hỏi tri thức; sự kiện finish mang data = { reply, questions, grounded, citations[] }
 *     responses:
 *       200:
 *         description: text/event-stream — sự kiện text-delta (CHAT), finish, error
 *       409:
 *         description: KNOWLEDGE_DISABLED — gửi knowledge=true khi server tắt Knowledge RAG
 */
router.post("/:projectId/chats/:chatId/messages/stream", authMiddleware, requireRole("lead", "analyst"), chatSessionController.sendMessageStream)

export default router
