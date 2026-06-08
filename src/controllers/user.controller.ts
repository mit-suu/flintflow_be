import { Request, Response } from "express"
import * as userService from "../services/user.service.js"
import { ApiResponse } from "../utils/response.js"
import { catchAsync } from "../utils/catch-async.js"
import { HTTP_STATUS } from "../constants/http-status.js"

export const getMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    return ApiResponse.send(res, HTTP_STATUS.UNAUTHORIZED, "User not authenticated")
  }

  const user = await userService.getUserById(userId)
  return ApiResponse.send(res, HTTP_STATUS.OK, "User fetched successfully", user)
})

export const getUserById = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const user = await userService.getUserById(id)
  return ApiResponse.send(res, HTTP_STATUS.OK, "User fetched successfully", user)
})
