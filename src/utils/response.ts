import { Response } from "express"

export class ApiResponse {
  constructor(
    public statusCode: number,
    public message: string,
    public success: boolean,
    public data: any = null
  ) {}

  static send(res: Response, statusCode: number, message: string, data: any = null) {
    return res.status(statusCode).json({
      success: statusCode < 400,
      message,
      data
    })
  }
}
