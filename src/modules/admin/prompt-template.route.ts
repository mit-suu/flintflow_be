import { Router } from "express"
import {
  listPromptTemplates,
  getActivePromptTemplate,
  getPromptTemplateHistory,
  createPromptTemplate,
  updatePromptTemplate,
  activatePromptTemplateVersion
} from "./prompt-template.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { adminMiddleware } from "../../shared/auth/admin.middleware.js"

const router = Router()

router.use(authMiddleware, adminMiddleware)

router.get("/", listPromptTemplates)
router.post("/", createPromptTemplate)

router.get("/:actionType", getActivePromptTemplate)
router.put("/:actionType", updatePromptTemplate)

router.get("/:actionType/history", getPromptTemplateHistory)
router.patch("/:actionType/activate/:version", activatePromptTemplateVersion)

export default router
