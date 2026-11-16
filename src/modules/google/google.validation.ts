import { z } from "zod"

/** Mã uỷ quyền một lần từ popup `useGoogleLogin({ flow: "auth-code" })`. */
export const ConnectGoogleSchema = z.object({
  code: z.string().trim().min(1).max(2048)
})

export type ConnectGoogleDTO = z.infer<typeof ConnectGoogleSchema>

/** `update` (mặc định): ghi đè Google Doc đã xuất gần nhất cùng nguồn + ngôn ngữ; chưa có thì tạo mới. */
export const GoogleExportSchema = z.object({
  mode: z.enum(["new", "update"]).default("update")
})
