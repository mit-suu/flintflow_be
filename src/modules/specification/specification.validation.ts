import { z } from "zod"

/**
 * Validate projectId from URL params
 */
export const projectIdParamSchema = z.object({
  projectId: z.string().min(1, "projectId is required")
})
