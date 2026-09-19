import { z } from "zod"
import { FOLDER_COLORS, FOLDER_NAME_MAX } from "./folder.model.js"

const name = z.string().trim().min(1).max(FOLDER_NAME_MAX)

export const CreateFolderSchema = z.object({
  name,
  color: z.enum(FOLDER_COLORS).default("violet")
})

export const UpdateFolderSchema = z
  .object({ name: name.optional(), color: z.enum(FOLDER_COLORS).optional() })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: "Cần name hoặc color" })

export type CreateFolderDTO = z.infer<typeof CreateFolderSchema>
export type UpdateFolderDTO = z.infer<typeof UpdateFolderSchema>
