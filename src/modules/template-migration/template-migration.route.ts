import { Router } from "express"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import * as controller from "./template-migration.controller.js"

/**
 * Đổi mẫu của dự án sau baseline (FLF-395, D5 / D8 / D14 / D15) — mount ở `/api/v1/projects`, đi sau chuỗi guard theo tiền tố
 * của `app.ts` (token → tài khoản → membership). Chỉ Lead / Analyst; Viewer ⇒ 403. Contract: `docs/api/import-change-contract.md`
 * §FLF-395 "Đổi mẫu".
 */
const editor = requireRole("lead", "analyst")

const router = Router()
router.post("/:id/template-migrations", authMiddleware, editor, controller.receiveTemplateFile, controller.start)
router.get("/:id/template-migrations", authMiddleware, editor, controller.list)
router.get("/:id/template-migrations/:migrationId", authMiddleware, editor, controller.get)
router.patch("/:id/template-migrations/:migrationId/pairs", authMiddleware, editor, controller.patchPairs)
router.patch("/:id/template-migrations/:migrationId/mapping", authMiddleware, editor, controller.patchMapping)
router.post("/:id/template-migrations/:migrationId/confirm-mapping", authMiddleware, editor, controller.confirmMapping)
router.patch("/:id/template-migrations/:migrationId/decisions", authMiddleware, editor, controller.patchDecisions)
router.post("/:id/template-migrations/:migrationId/ready", authMiddleware, editor, controller.ready)
router.post("/:id/template-migrations/:migrationId/cancel", authMiddleware, editor, controller.cancel)
router.post("/:id/template-migrations/:migrationId/apply", authMiddleware, editor, controller.apply)
router.post("/:id/template-migrations/:migrationId/revert", authMiddleware, editor, controller.revert)
router.post("/:id/template-migrations/:migrationId/restore", authMiddleware, editor, controller.restore)

export default router
