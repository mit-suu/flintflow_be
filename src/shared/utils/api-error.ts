export class ApiError extends Error {
  public statusCode: number
  public code: string
  /** Chi tiết kỹ thuật cho debug (đi vào `meta` của envelope) — không bao giờ nằm trong `message` (FLF-247). */
  public meta?: Record<string, unknown>

  constructor(statusCode: number, message: string, code?: string, meta?: Record<string, unknown>) {
    super(message)
    this.statusCode = statusCode
    this.code = code || `HTTP_${statusCode}`
    if (meta) this.meta = meta
    Error.captureStackTrace(this, this.constructor)
  }
}
