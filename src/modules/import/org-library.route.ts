import { Router } from "express"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireActiveAccount } from "../../shared/auth/account-guard.middleware.js"
import { orgContextFromParam } from "../../shared/auth/org-context.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import * as controller from "./org-library.controller.js"

/**
 * FLF-278 trên FLF-335/336 — mẫu của tổ chức. Mọi thành viên xem; Lead + Analyst sửa / xoá (Viewer bị
 * chặn ở `requireRole`). Mount ở `/api/v1/orgs` cạnh route tổ chức.
 */
const inOrg = [authMiddleware, requireActiveAccount, orgContextFromParam()] as const
const editor = requireRole("lead", "analyst")

const router = Router()
router.get("/:orgId/templates", ...inOrg, controller.listOrgTemplates)
router.delete("/:orgId/templates/:templateId", ...inOrg, editor, controller.deleteOrgTemplate)
export default router
