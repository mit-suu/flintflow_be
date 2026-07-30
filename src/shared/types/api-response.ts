import { Response } from "express"

export interface ApiErrorDetail {
  code: string
  message: string
}

export interface ApiResponse<T = unknown> {
  data: T | null
  meta?: Record<string, unknown>
  error: ApiErrorDetail | null
}

export const sendResponse = <T>(
  res: Response,
  statusCode: number,
  data: T | null = null,
  meta?: Record<string, unknown>,
  error: ApiErrorDetail | null = null
): Response => {
  const payload: ApiResponse<T> = {
    data,
    ...(meta ? { meta } : {}),
    error
  }
  return res.status(statusCode).json(payload)
}

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  data: T,
  meta?: Record<string, unknown>
): Response => {
  return sendResponse(res, statusCode, data, meta, null)
}

export const sendError = (
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  meta?: Record<string, unknown>
): Response => {
  return sendResponse(res, statusCode, null, meta, { code, message })
}
