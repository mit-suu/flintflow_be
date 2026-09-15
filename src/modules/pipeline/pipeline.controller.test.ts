import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./step-runner.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./step-runner.service.js")>()
  return { ...actual, runStep: vi.fn() }
})
vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn() }
})

import { runStepController } from "./pipeline.controller.js"
import { getProjectById } from "../project/project.service.js"
import { runStep, NOT_PIPELINE_SESSION } from "./step-runner.service.js"
import { get as getSpine } from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"

const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"

interface Outcome {
  statusHeaders: number
  headers: Record<string, string>
  headersFlushed: boolean
  written: string[]
  ended: boolean
  error?: unknown
}

/** Mock `res` tối thiểu cho SSE: theo dõi setHeader/flushHeaders/write/end — không cần supertest. */
const invokeSse = (handler: RequestHandler, userId: string | undefined, projectId: string, stepId: string, body: unknown) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = { statusHeaders: 0, headers: {}, headersFlushed: false, written: [], ended: false }
    const req = { user: userId ? { userId } : undefined, params: { projectId, stepId }, body } as unknown as Request
    const res = {
      writableEnded: false,
      setHeader(name: string, value: string) {
        outcome.headers[name] = value
        return this
      },
      flushHeaders() {
        outcome.headersFlushed = true
      },
      write(chunk: string) {
        outcome.written.push(chunk)
        return true
      },
      end() {
        outcome.ended = true
        ;(res as unknown as { writableEnded: boolean }).writableEnded = true
        resolve(outcome)
      }
    } as unknown as Response
    const next: NextFunction = (err?: unknown) => {
      outcome.error = err
      resolve(outcome)
    }
    handler(req, res, next)
  })

beforeEach(() => {
  vi.mocked(getProjectById).mockReset()
  vi.mocked(runStep).mockReset()
  vi.mocked(getSpine).mockReset()
  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    return { name: "Lumen", domain: null } as never
  })
  vi.mocked(getSpine).mockResolvedValue(null)
})

describe("POST /projects/:projectId/steps/:stepId/run", () => {
  it("session không pipeline ⇒ 403 NOT_PIPELINE_SESSION KHÔNG mở SSE (lỗi guard-clause trước emit đầu tiên)", async () => {
    vi.mocked(runStep).mockRejectedValue(new ApiError(403, "Session này không phải session pipeline", NOT_PIPELINE_SESSION))

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.error).toBeInstanceOf(ApiError)
    expect((outcome.error as ApiError).statusCode).toBe(403)
    expect((outcome.error as ApiError).code).toBe(NOT_PIPELINE_SESSION)
    // Guard-clause: KHÔNG có sự kiện nào được ghi, SSE header chưa mở
    expect(outcome.headersFlushed).toBe(false)
    expect(outcome.written).toHaveLength(0)
  })

  it("dự án không thuộc user ⇒ 404 PROJECT_NOT_FOUND, không gọi runStep", async () => {
    const outcome = await invokeSse(runStepController, "other-user", PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.error).toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(runStep).not.toHaveBeenCalled()
  })

  it("thiếu session_id ⇒ 400 VALIDATION_ERROR", async () => {
    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { base_version: 1 })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })

  it("lỗi giữa chừng (đã emit ≥ 1 sự kiện) ⇒ phát SSE `error` rồi đóng luồng, không next(err)", async () => {
    vi.mocked(runStep).mockImplementation(async (_p, stepId, _s, _u, emit) => {
      emit({ type: "intake", step_id: stepId, phase: "S-3", empty_fields: [] })
      throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác.", "SPINE_VERSION_CONFLICT")
    })

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.error).toBeUndefined()
    expect(outcome.headersFlushed).toBe(true)
    expect(outcome.written.some((w) => w.startsWith("event: intake"))).toBe(true)
    expect(outcome.written.some((w) => w.startsWith("event: error"))).toBe(true)
    expect(outcome.written.some((w) => w.includes("SPINE_VERSION_CONFLICT"))).toBe(true)
    expect(outcome.ended).toBe(true)
  })

  it("base_version lệch trước khi mở SSE ⇒ 409 SPINE_VERSION_CONFLICT, không gọi runStep", async () => {
    vi.mocked(getSpine).mockResolvedValue({ spine_version: 5 } as never)

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.error).toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
    expect(runStep).not.toHaveBeenCalled()
    expect(outcome.headersFlushed).toBe(false)
  })
})
