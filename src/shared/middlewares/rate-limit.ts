import { Request, Response, NextFunction } from "express"

export const rateLimit = (_req: Request, _res: Response, next: NextFunction): void => {
  // Placeholder rate limiter middleware for future implementation
  next()
}
