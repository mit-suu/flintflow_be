import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./spine.repository.js", () => ({ getOrCreate: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))

import { getSpine } from "./spine.controller.js"
import spineRoutes from "./spine.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { getProjectById } from "../project/project.service.js"
import { getOrCreate } from "./spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"

const OWNER = "650000000000000000000010"
const STRANGER = "650000000000000000000020"
const PROJECT = "650000000000000000000001"

interface Outcome {
  status?: number
  body?: unknown
  error?: unknown
}

const invoke = (userId: string | undefined, projectId: string) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = {}
    const req = { user: userId ? { userId } : undefined, params: { projectId } } as unknown as Request
    const res = {
      status(code: number) {
        outcome.status = code
        return this
      },
      json(body: unknown) {
        outcome.body = body
        resolve(outcome)
        return this
      }
    } as unknown as Response
    const next: NextFunction = (err?: unknown) => {
      outcome.error = err
      resolve(outcome)
    }
    getSpine(req, res, next)
  })

beforeEach(async () => {
  vi.mocked(getProjectById).mockReset()
  vi.mocked(getOrCreate).mockReset()

  // Mô phỏng getProjectById thật: lọc theo { _id, userId }
  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) {
      throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    }
    return { name: "Lumen", domain: "E-learning" } as never
  })

  const actual = await vi.importActual<typeof import("./spine.repository.js")>("./spine.repository.js")
  vi.mocked(getOrCreate).mockImplementation(async (projectId, init) => ({
    projectId,
    ...actual.createEmptySpine(init)
  }))
})

describe("GET /projects/:projectId/spine", () => {
  it("200 cho chủ project, trả Spine", async () => {
    const outcome = await invoke(OWNER, PROJECT)

    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({
      data: { projectId: PROJECT, spine_version: 1, project: { name: "Lumen" } },
      error: null
    })
    expect(getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "Lumen", domain: "E-learning" })
  })

  it("404 cho người không sở hữu, không tạo Spine", async () => {
    const outcome = await invoke(STRANGER, PROJECT)

    expect(outcome.status).toBeUndefined()
    expect(outcome.error).toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(getOrCreate).not.toHaveBeenCalled()
  })

  it("404 khi projectId sai định dạng (không để CastError thành 500)", async () => {
    const outcome = await invoke(OWNER, "not-an-object-id")

    expect(outcome.error).toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(getProjectById).not.toHaveBeenCalled()
  })

  it("401 khi thiếu user", async () => {
    const outcome = await invoke(undefined, PROJECT)
    expect(outcome.error).toMatchObject({ statusCode: 401 })
  })

  it("route được đăng ký GET kèm authMiddleware", () => {
    const layer = spineRoutes.stack.find((l) => l.route?.path === "/:projectId/spine")
    expect(layer, "thiếu route /:projectId/spine").toBeDefined()

    const route = layer?.route as unknown as { methods: Record<string, boolean>; stack: { handle: unknown }[] }
    expect(route.methods.get).toBe(true)
    expect(route.stack[0].handle).toBe(authMiddleware)
  })
})
