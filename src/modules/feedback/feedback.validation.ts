import { z } from "zod"
import { FEEDBACK_CATEGORIES, FEEDBACK_MESSAGE_MAX } from "./feedback.model.js"

export const CreateFeedbackSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX)
})

export type CreateFeedbackDTO = z.infer<typeof CreateFeedbackSchema>
