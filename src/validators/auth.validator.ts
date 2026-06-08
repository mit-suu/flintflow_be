import { loginSchema } from "../dtos/auth/login.dto.js"
import { registerSchema } from "../dtos/auth/register.dto.js"

export const validateLogin = (data: any) => {
  return loginSchema.safeParse(data)
}

export const validateRegister = (data: any) => {
  return registerSchema.safeParse(data)
}
