import { z } from "zod"
import { ApiError } from "../../shared/utils/api-error.js"

/** Múi giờ gom nhóm theo ngày cho báo cáo admin (dữ liệu vận hành ở VN). */
export const REPORT_TIMEZONE = "Asia/Ho_Chi_Minh"
const REPORT_UTC_OFFSET = "+07:00"

/** Khoảng tối đa một lần truy vấn ai-cost, tránh aggregate quét cả collection. */
export const MAX_RANGE_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const booleanString = z
  .enum(["true", "false"], { message: "isActive phải là true hoặc false" })
  .transform((v) => v === "true")

export const usersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(["user", "admin"], { message: "role phải là user hoặc admin" }).optional(),
  isActive: booleanString.optional(),
  q: z.string().trim().max(100, "Từ khoá tối đa 100 ký tự").optional()
})

export const userIdParamSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, "userId không hợp lệ")
})

export const AI_COST_GROUP_BY = ["day", "actionType", "provider", "user"] as const

const dateInput = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(parseDateInput(v, "start").getTime()), "Ngày không hợp lệ (YYYY-MM-DD hoặc ISO)")

export const aiCostQuerySchema = z.object({
  from: dateInput.optional(),
  to: dateInput.optional(),
  groupBy: z.enum(AI_COST_GROUP_BY, { message: "groupBy phải là day | actionType | provider | user" }).default("day")
})

export type UsersQuery = z.infer<typeof usersQuerySchema>
export type AiCostQuery = z.infer<typeof aiCostQuerySchema>
export type AiCostGroupBy = (typeof AI_COST_GROUP_BY)[number]

/**
 * `YYYY-MM-DD` hiểu theo REPORT_TIMEZONE; `edge = "end"` trả về đầu ngày kế tiếp
 * (dùng làm cận trên loại trừ). Chuỗi ISO đầy đủ giữ nguyên thời điểm.
 */
export function parseDateInput(value: string, edge: "start" | "end"): Date {
  if (DATE_ONLY.test(value)) {
    const start = new Date(`${value}T00:00:00${REPORT_UTC_OFFSET}`)
    return edge === "end" ? new Date(start.getTime() + DAY_MS) : start
  }
  return new Date(value)
}

/** Khoảng `[from, to)`; mặc định 30 ngày gần nhất tính đến hiện tại. */
export function resolveDateRange(
  query: Pick<AiCostQuery, "from" | "to">,
  now: Date = new Date()
): { from: Date; to: Date } {
  const to = query.to ? parseDateInput(query.to, "end") : now
  const from = query.from ? parseDateInput(query.from, "start") : new Date(to.getTime() - 30 * DAY_MS)

  if (from.getTime() >= to.getTime()) {
    throw new ApiError(400, "from phải trước to", "VALIDATION_ERROR")
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ApiError(400, `Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày`, "VALIDATION_ERROR")
  }
  return { from, to }
}

export const parseWith = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input ?? {})
  if (!result.success) {
    const errorMessage = result.error.issues.map((issue) => issue.message).join(", ")
    throw new ApiError(400, errorMessage, "VALIDATION_ERROR")
  }
  return result.data
}
