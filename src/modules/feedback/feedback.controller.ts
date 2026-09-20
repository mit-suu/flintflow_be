import { Request, Response } from "express"
import * as feedbackService from "./feedback.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { CreateFeedbackDTO } from "./feedback.validation.js"

export const createFeedback = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  // Body đã qua CreateFeedbackSchema ở route
  const feedback = await feedbackService.createFeedback(userId, req.body as CreateFeedbackDTO)
  return sendSuccess(res, 201, feedback)
})
