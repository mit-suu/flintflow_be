import { z } from "zod"

/** Mã uỷ quyền một lần từ popup `useGoogleLogin({ flow: "auth-code" })`. */
export const ConnectGoogleSchema = z.object({
  code: z.string().trim().min(1).max(2048)
})

export type ConnectGoogleDTO = z.infer<typeof ConnectGoogleSchema>

/** File người dùng chọn trong Google Picker (contract #46). ID Drive chỉ gồm chữ, số, `_`, `-`. */
export const ImportGoogleDocSchema = z.object({
  fileId: z.string().trim().min(1).max(200).regex(/^[\w-]+$/)
})

/** Google Doc chọn trong Picker để liên kết vào dự án — cùng dạng id với nhập. */
export const LinkGoogleDocSchema = ImportGoogleDocSchema

/**
 * `update` (mặc định): ghi đè Google Doc đã xuất gần nhất cùng nguồn + ngôn ngữ; chưa có thì tạo mới.
 * `force`: ghi đè dù Doc đã bị sửa trong Google Docs sau lần xuất trước (sau khi người dùng xác nhận `GOOGLE_DOC_MODIFIED`).
 */
export const GoogleExportSchema = z.object({
  mode: z.enum(["new", "update"]).default("update"),
  force: z.boolean().default(false)
})
