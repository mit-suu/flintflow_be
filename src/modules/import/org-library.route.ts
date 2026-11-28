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
// UC-88: Lead duyệt đề xuất mẫu Analyst gửi từ dự án
router.get("/:orgId/template-proposals", ...inOrg, lead, controller.listTemplateProposals)
router.get("/:orgId/template-proposals/:proposalId", ...inOrg, lead, controller.getOrgTemplateProposal)
router.post("/:orgId/template-proposals/:proposalId/approve", ...inOrg, lead, controller.approveTemplateProposal)
router.post("/:orgId/template-proposals/:proposalId/reject", ...inOrg, lead, controller.rejectTemplateProposal)
export default router
