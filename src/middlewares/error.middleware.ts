import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/response.js"
import { HTTP_STATUS } from "../constants/http-status.js"

export const errorMiddleware = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (error instanceof ApiError) {
    return ApiResponse.send(res, error.statusCode, error.message)
  }

  console.error("Unhandled error:", error)
  return ApiResponse.send(
    res,
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
    error.message || "Internal server error"
  )
}
