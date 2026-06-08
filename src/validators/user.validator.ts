import { z } from "zod"

const getUserSchema = z.object({
  id: z.string()
})

export const validateGetUser = (data: any) => {
  return getUserSchema.safeParse(data)
}
