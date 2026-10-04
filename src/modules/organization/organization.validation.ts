import { z } from "zod"
import { ORG_NAME_MAX } from "./organization.model.js"
import { ORG_ROLES } from "./membership.model.js"
import { INVITABLE_ROLES } from "./invitation.model.js"

export const CreateOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Tên tổ chức không được để trống")
    .max(ORG_NAME_MAX, `Tên tổ chức tối đa ${ORG_NAME_MAX} ký tự`)
})

export const RenameOrganizationSchema = CreateOrganizationSchema

/** UC-73 cho phép đặt cả vai trò Lead — khác UC-08 (mời) chỉ có Analyst / Viewer. */
export const ChangeRoleSchema = z.object({
  role: z.enum(ORG_ROLES)
})

/** Xoá org: gõ lại đúng tên để xác nhận — thao tác không khôi phục được. */
export const DeleteOrganizationSchema = z.object({
  confirmName: z.string().min(1, "Hãy gõ lại tên tổ chức để xác nhận")
})

export type DeleteOrganizationDTO = z.infer<typeof DeleteOrganizationSchema>
export type CreateOrganizationDTO = z.infer<typeof CreateOrganizationSchema>
export type RenameOrganizationDTO = z.infer<typeof RenameOrganizationSchema>
export type ChangeRoleDTO = z.infer<typeof ChangeRoleSchema>

/**
 * UC-08: mã mời chỉ gắn được Analyst hoặc Viewer — Lead phải nâng qua UC-73.
 * Email BẮT BUỘC (góp ý mentor 2026-10-02: "mời mà không cần email là trái lẽ thường"): UC-08 nói Email Service
 * gửi mã cho người được mời, nên phải biết gửi cho ai.
 */
export const CreateInvitationSchema = z.object({
  role: z.enum(INVITABLE_ROLES),
  email: z.string("Hãy nhập email người được mời").trim().toLowerCase().pipe(z.email("Email không hợp lệ"))
})

export type CreateInvitationDTO = z.infer<typeof CreateInvitationSchema>
