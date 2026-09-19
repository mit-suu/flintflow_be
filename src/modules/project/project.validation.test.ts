import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { CreateProjectSchema, validateRequest } from "./project.validation.js"

const run = (body: unknown) => {
  const req = { body } as Request
  const next = vi.fn()
  validateRequest(CreateProjectSchema)(req, {} as Response, next)
  return { req, next }
}

describe("CreateProjectSchema qua validateRequest", () => {
  it.each(["edit_srs", "fpt_template", "customer_template"])("nhận sourceMode %s, trim tên", (mode) => {
    const { req, next } = run({ name: "  Lumen  ", sourceMode: mode })

    expect(next).toHaveBeenCalledOnce()
    expect(req.body).toEqual({ name: "Lumen", sourceMode: mode })
  })

  it.each([
    ["thiếu sourceMode", { name: "Lumen" }],
    ["sourceMode lạ", { name: "Lumen", sourceMode: "coaching" }],
    ["tên chỉ có khoảng trắng", { name: "   ", sourceMode: "edit_srs" }],
    ["tên quá 100 ký tự", { name: "x".repeat(101), sourceMode: "edit_srs" }]
  ])("%s ⇒ 400 VALIDATION_ERROR", (_label, body) => {
    expect(() => run(body)).toThrow(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }))
  })
})
