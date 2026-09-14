import type { NextFunction, Request, Response } from "express"
import { describe, it, expect, vi } from "vitest"
import {
  activatePromptTemplateVersion,
  createPromptTemplate,
  getActivePromptTemplate,
  updatePromptTemplate
} from "./prompt-template.controller.js"
import { ApiError } from "../../shared/utils/api-error.js"

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }
}

describe("admin prompt-template read-only (T03)", () => {
  it.each([
    ["POST /", createPromptTemplate],
    ["PUT /:actionType", updatePromptTemplate],
    ["PATCH /:actionType/activate/:version", activatePromptTemplateVersion]
  ])("%s trả 410 PROMPT_OVERRIDE_DISABLED", async (_route, handler) => {
    const next = vi.fn()
    await handler({ params: { actionType: "chat" }, body: {} } as unknown as Request, mockRes(), next as NextFunction)

    const err = next.mock.calls[0][0] as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.statusCode).toBe(410)
    expect(err.code).toBe("PROMPT_OVERRIDE_DISABLED")
  })

  it("GET /:actionType trả bản trên đĩa", async () => {
    const res = mockRes()
    const next = vi.fn()
    await getActivePromptTemplate({ params: { actionType: "draft" } } as unknown as Request, res, next as NextFunction)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = JSON.stringify(res.json.mock.calls[0][0])
    expect(payload).toContain("draft-to-ops")
  })

  it("GET /:actionType không tồn tại → 404", async () => {
    const next = vi.fn()
    await getActivePromptTemplate({ params: { actionType: "khong_co" } } as unknown as Request, mockRes(), next as NextFunction)

    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(404)
  })
})
