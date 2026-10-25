import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { viewerReadScope } from "./viewer-read-scope.middleware.js"
import { ApiError } from "../utils/api-error.js"

const run = (method: string, role: string | undefined, path: string) => {
  const req = { method, path, orgContext: role ? { orgId: "o1", role, membershipId: "m1" } : undefined } as unknown as Request
  const next = vi.fn()
  viewerReadScope()(req, {} as Response, next)
  return next.mock.calls[0]?.[0] as ApiError | undefined
}

const ALLOWED = [
  "/",
  "/p1",
  "/p1/document",
  "/p1/export/word",
  "/p1/diagrams",
  "/p1/diagrams/uc.png",
  "/p1/baselines",
  "/p1/versions",
  "/p1/versions/compare",
  "/p1/versions/1.0/blocks",
  "/p1/versions/1.0/download",
  "/p1/progress",
  "/p1/traceability",
  "/p1/comments"
]

const DENIED = [
  "/p1/spine",
  "/p1/flags",
  "/p1/changes",
  "/p1/sources",
  "/p1/documents",
  "/p1/chats",
  "/p1/chats/c1",
  "/p1/change-requests",
  "/p1/change-requests/CR-001",
  "/p1/steps",
  "/p1/steps/S-1.1/run-state",
  "/p1/run-state/active",
  "/p1/gap-report",
  "/p1/import",
  "/p1/step-plan",
  "/p1/translations/status"
]

describe("viewerReadScope (UC-47/50/51)", () => {
  it.each(ALLOWED)("Viewer GET %s được", (path) => {
    expect(run("GET", "viewer", path)).toBeUndefined()
  })

  it.each(DENIED)("Viewer GET %s ⇒ 403 ORG_ROLE_FORBIDDEN", (path) => {
    const err = run("GET", "viewer", path)
    expect(err).toBeInstanceOf(ApiError)
    expect(err?.statusCode).toBe(403)
    expect(err?.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("Lead và Analyst đọc mọi thứ", () => {
    for (const path of DENIED) {
      expect(run("GET", "lead", path)).toBeUndefined()
      expect(run("GET", "analyst", path)).toBeUndefined()
    }
  })

  it("không đụng tới thao tác ghi (đã do viewerReadOnly lo) và route không thuộc org", () => {
    expect(run("POST", "viewer", "/p1/comments")).toBeUndefined()
    expect(run("GET", undefined, "/p1/spine")).toBeUndefined()
  })
})
