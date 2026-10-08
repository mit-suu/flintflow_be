import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { requireRole } from "./require-role.middleware.js"
import { ApiError } from "../utils/api-error.js"

const run = (orgRole: string | undefined, allowed: Parameters<typeof requireRole>) => {
  const req = (orgRole ? { orgContext: { orgId: "o1", role: orgRole, membershipId: "m1" } } : {}) as Request
  const next = vi.fn()
  requireRole(...allowed)(req, {} as Response, next)
  return next.mock.calls[0]?.[0] as ApiError | undefined
}

describe("requireRole (BPMN Flow 10.7)", () => {
  it("vai trò được phép thì đi tiếp", () => {
    expect(run("lead", ["lead"])).toBeUndefined()
    expect(run("analyst", ["lead", "analyst"])).toBeUndefined()
  })

  it("Viewer bị chặn khỏi thao tác của Author", () => {
    const err = run("viewer", ["lead", "analyst"])
    expect(err).toBeInstanceOf(ApiError)
    expect(err?.statusCode).toBe(403)
    expect(err?.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("Analyst không làm được việc của Lead", () => {
    expect(run("analyst", ["lead"])?.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("thiếu orgContext là lỗi cấu hình route, không phải 403", () => {
    const err = run(undefined, ["lead"])
    expect(err?.statusCode).toBe(500)
    expect(err?.code).toBe("ORG_CONTEXT_MISSING")
  })
})
