import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { viewerReadOnly } from "./viewer-read-only.middleware.js"
import { ApiError } from "../utils/api-error.js"

const run = (method: string, role: string | undefined, path = "/p1/changes", allow: RegExp[] = []) => {
  const req = { method, path, orgContext: role ? { orgId: "o1", role, membershipId: "m1" } : undefined } as unknown as Request
  const next = vi.fn()
  viewerReadOnly(allow)(req, {} as Response, next)
  return next.mock.calls[0]?.[0] as ApiError | undefined
}

describe("viewerReadOnly", () => {
  it("Viewer đọc được (GET/HEAD/OPTIONS)", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(run(method, "viewer")).toBeUndefined()
  })

  it("Viewer ghi bị chặn 403 ORG_ROLE_FORBIDDEN với mọi phương thức ghi", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const err = run(method, "viewer")
      expect(err).toBeInstanceOf(ApiError)
      expect(err?.statusCode).toBe(403)
      expect(err?.code).toBe("ORG_ROLE_FORBIDDEN")
    }
  })

  it("Lead và Analyst ghi bình thường", () => {
    expect(run("POST", "lead")).toBeUndefined()
    expect(run("DELETE", "analyst")).toBeUndefined()
  })

  it("đường dẫn trong allowlist thì Viewer được ghi (vd ghép bản đọc)", () => {
    const allow = [/^\/[^/]+\/assemble$/]
    expect(run("POST", "viewer", "/p1/assemble", allow)).toBeUndefined()
    expect(run("POST", "viewer", "/p1/assemble/x", allow)?.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(run("POST", "viewer", "/p1/changes", allow)?.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("không có orgContext (route không thuộc org) thì không can thiệp", () => {
    expect(run("POST", undefined)).toBeUndefined()
  })
})
