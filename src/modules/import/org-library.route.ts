import { Router } from "express"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireActiveAccount } from "../../shared/auth/account-guard.middleware.js"
import { orgContextFromParam } from "../../shared/auth/org-context.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import * as controller from "./org-library.controller.js"

/**
 * FLF-278 trên FLF-335/336 — mẫu của tổ chức. Mọi thành viên xem; chỉ Lead đăng / xoá mẫu và bản (FLF-395; vai trò khác bị
 * chặn ở `requireRole`). Mount ở `/api/v1/orgs` cạnh route tổ chức.
 */
const inOrg = [authMiddleware, requireActiveAccount, orgContextFromParam()] as const
/** FLF-395: chỉ Lead đăng mẫu dùng chung cho org (chặn trước khi nhận file). */
const lead = requireRole("lead")

const router = Router()
router.get("/:orgId/templates", ...inOrg, controller.listOrgTemplates)
router.post("/:orgId/templates", ...inOrg, lead, controller.receiveTemplateFile, controller.uploadTemplate)
router.delete("/:orgId/templates/:templateId", ...inOrg, lead, controller.deleteOrgTemplate)
router.post("/:orgId/templates/:templateId/versions", ...inOrg, lead, controller.receiveTemplateFile, controller.uploadTemplate)
router.get("/:orgId/templates/:templateId/versions/:version", ...inOrg, controller.getTemplateVersion)
router.post("/:orgId/templates/:templateId/versions/:version/publish", ...inOrg, lead, controller.publishTemplateVersion)
router.delete("/:orgId/templates/:templateId/versions/:version", ...inOrg, lead, controller.deleteTemplateVersion)
export default router
