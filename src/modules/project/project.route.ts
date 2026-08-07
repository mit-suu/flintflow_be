import { Router } from "express"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { validateRequest, CreateProjectSchema, RenameProjectSchema } from "./project.validation.js"
import * as projectController from "./project.controller.js"

const router = Router()

router.get("/", authMiddleware, projectController.listProjects)
router.post("/", authMiddleware, validateRequest(CreateProjectSchema), projectController.createProject)
router.patch("/:id/name", authMiddleware, validateRequest(RenameProjectSchema), projectController.renameProject)
router.delete("/:id", authMiddleware, projectController.archiveProject)

export default router
