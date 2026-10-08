import { describe, expect, it } from "vitest"
import { z } from "zod"
import { GENERIC_VALIDATION_MESSAGE, validationError, validationMessage, validationMeta } from "./validation-message.js"

const fail = (schema: z.ZodType, value: unknown): z.ZodError => {
  const parsed = schema.safeParse(value)
  if (parsed.success) throw new Error("schema phải trượt")
  return parsed.error
}

describe("validationMessage (FLF-247)", () => {
  it("mọi issue có câu do schema tự viết ⇒ nối các câu, bỏ trùng", () => {
    const schema = z.object({
      email: z.string().email("Email không hợp lệ."),
      backup: z.string().email("Email không hợp lệ."),
      password: z.string().min(1, "Vui lòng nhập mật khẩu")
    })
    const error = fail(schema, { email: "x", backup: "y", password: "" })
    expect(validationMessage(error)).toBe("Email không hợp lệ.; Vui lòng nhập mật khẩu")
  })

  it("câu do refine/superRefine tự đặt cũng tính là câu của schema", () => {
    const schema = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((v) => v.a !== undefined || v.b !== undefined, { message: "Chưa có thông tin nào để cập nhật." })
    expect(validationMessage(fail(schema, {}))).toBe("Chưa có thông tin nào để cập nhật.")
  })

  it("còn issue chỉ có câu mặc định của Zod (thiếu field, sai kiểu) ⇒ câu chung", () => {
    const schema = z.object({ base_version: z.number(), name: z.string().min(1, "Tên không được để trống") })
    const error = fail(schema, { name: "" })
    expect(validationMessage(error)).toBe(GENERIC_VALIDATION_MESSAGE)
  })

  it("câu không lộ path, mã issue hay ký hiệu prettifyError", () => {
    const error = fail(z.object({ base_version: z.number() }), {})
    const message = validationMessage(error)
    expect(message).not.toMatch(/base_version|✖|→|invalid_type/)
  })

  it("câu mặc định của Zod (không đổi locale) nằm trong meta.issues kèm path, không tới message", () => {
    const error = fail(z.object({ steps: z.array(z.object({ id: z.string() })) }), { steps: [{}] })
    const meta = validationMeta(error)
    expect(meta.issues).toHaveLength(1)
    expect(meta.issues[0]!.path).toBe("steps.0.id")
    expect(meta.issues[0]!.message).toMatch(/Invalid input/)
    expect(validationMessage(error)).toBe(GENERIC_VALIDATION_MESSAGE)
  })

  it("validationError ⇒ ApiError 400 VALIDATION_ERROR có meta.issues", () => {
    const err = validationError(fail(z.object({ id: z.string().min(1, "Thiếu mã") }), { id: "" }))
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe("VALIDATION_ERROR")
    expect(err.message).toBe("Thiếu mã")
    expect(err.meta).toEqual({ issues: [{ path: "id", message: "Thiếu mã" }] })
  })
})
