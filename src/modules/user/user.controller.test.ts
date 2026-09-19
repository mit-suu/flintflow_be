import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("./user.service.js", () => ({ getUserById: vi.fn(), updateMe: vi.fn() }))

import { updateMe } from "./user.controller.js"
import * as userService from "./user.service.js"

const USER = "650000000000000000000010"

const invoke = (handler: RequestHandler, userId: string | undefined, body: unknown) =>
  new Promise<{ status: number; body: unknown; error?: unknown }>((resolve) => {
    const req = { user: userId ? { userId } : undefined, params: {}, body } as unknown as Request
    const res = {
      status(code: number) {
        ;(res as unknown as { _status: number })._status = code
        return res
      },
      json(payload: unknown) {
        resolve({ status: (res as unknown as { _status: number })._status ?? 200, body: payload })
        return res
      }
    } as unknown as Response
    const next: NextFunction = (err?: unknown) => resolve({ status: 0, body: null, error: err })
    handler(req, res, next)
  })

beforeEach(() => {
  vi.mocked(userService.updateMe).mockReset()
  vi.mocked(userService.updateMe).mockImplementation(async (id, input) => ({ id, email: "a@b.c", onboardedAt: null, ...input }) as never)
})

describe("PATCH /users/me", () => {
  it("cập nhật name + onboardedAt (ISO → Date)", async () => {
    const outcome = await invoke(updateMe, USER, { name: "Hiệp", onboardedAt: "2026-09-15T08:00:00.000Z" })
    expect(outcome.status).toBe(200)
    expect(userService.updateMe).toHaveBeenCalledWith(USER, { name: "Hiệp", onboardedAt: new Date("2026-09-15T08:00:00.000Z") })
  })

  it("onboardedAt = null được phép (reset onboarding)", async () => {
    await invoke(updateMe, USER, { onboardedAt: null })
    expect(userService.updateMe).toHaveBeenCalledWith(USER, { onboardedAt: null })
  })

  it("body rỗng hoặc field lạ (role) ⇒ 400 VALIDATION_ERROR, không ghi", async () => {
    const empty = await invoke(updateMe, USER, {})
    const role = await invoke(updateMe, USER, { role: "admin" })
    expect(empty.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(role.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(userService.updateMe).not.toHaveBeenCalled()
  })

  it("chưa đăng nhập ⇒ 401", async () => {
    const outcome = await invoke(updateMe, undefined, { name: "x" })
    expect(outcome.error).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" })
  })
})

describe("PATCH /users/me — locale (T25)", () => {
  it("chỉ gửi locale là đủ", async () => {
    const outcome = await invoke(updateMe, USER, { locale: "en" })
    expect(outcome.status).toBe(200)
    expect(userService.updateMe).toHaveBeenCalledWith(USER, { locale: "en" })
  })

  it("locale ngoài vi/en ⇒ VALIDATION_ERROR, không ghi", async () => {
    const outcome = await invoke(updateMe, USER, { locale: "fr" })
    expect((outcome.error as { code?: string })?.code).toBe("VALIDATION_ERROR")
    expect(userService.updateMe).not.toHaveBeenCalled()
  })
})
