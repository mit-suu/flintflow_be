import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./step-runner.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./step-runner.service.js")>()
  return { ...actual, runStep: vi.fn(), requirePipelineSession: vi.fn() }
})
vi.mock("./gate.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gate.service.js")>()
  return { ...actual, gate: vi.fn() }
})
vi.mock("./resume.service.js", () => ({ resumeProject: vi.fn() }))
vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn(), getOrCreate: vi.fn() }
})
vi.mock("./meter.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./meter.service.js")>()
  return { ...actual, roundCountsForSteps: vi.fn(async () => new Map()) }
})

import { runStepController, getSteps, gateStep, answerStep, resumeProjectController } from "./pipeline.controller.js"
import { getProjectById } from "../project/project.service.js"
import { runStep, requirePipelineSession, NOT_PIPELINE_SESSION } from "./step-runner.service.js"
import { gate } from "./gate.service.js"
import { resumeProject } from "./resume.service.js"
import { ANSWER_MAX_CHARS } from "./pipeline.dto.js"
import { get as getSpine, getOrCreate } from "../spine/spine.repository.js"
import { roundCountsForSteps } from "./meter.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { AiActionError } from "../../shared/ai/ai-action.types.js"

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

/** Mock `res`/`req` tối thiểu cho SSE: theo dõi setHeader/flushHeaders/write/end — không cần supertest.
 *  `req.on` no-op (F8 wire `req.on("close", ...)` không điều kiện trong controller thật). */
const invokeSse = (handler: RequestHandler, userId: string | undefined, projectId: string, stepId: string, body: unknown) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = { statusHeaders: 0, headers: {}, headersFlushed: false, written: [], ended: false }
    const req = { user: userId ? { userId } : undefined, params: { projectId, stepId }, body, on: () => {} } as unknown as Request
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

/** Mock `req` có `on("close")` thật (F8) — trả thêm `triggerClose()` để test tự kích hoạt đóng kết nối
 *  giữa chừng. `res.end()` sẽ KHÔNG được gọi sau khi đóng (đúng hành vi mong đợi) nên không dùng để resolve
 *  Promise — gọi trực tiếp, không qua `invokeSse`, rồi `await flushMicrotasks()` trước khi assert. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.mocked(getProjectById).mockReset()
  vi.mocked(runStep).mockReset()
  vi.mocked(getSpine).mockReset()
  vi.mocked(getOrCreate).mockReset()
  vi.mocked(roundCountsForSteps).mockReset()
  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    return { name: "Lumen", domain: "E-learning" } as never
  })
  vi.mocked(getSpine).mockResolvedValue(null)
  vi.mocked(roundCountsForSteps).mockResolvedValue(new Map())
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

  it("F7: lỗi giữa chừng KHÔNG thuộc bảng mã pipeline (Error thường) ⇒ vẫn phát SSE `error` (NOT_IMPLEMENTED), không đóng im lặng", async () => {
    vi.mocked(runStep).mockImplementation(async (_p, stepId, _s, _u, emit) => {
      emit({ type: "intake", step_id: stepId, phase: "S-3", empty_fields: [] })
      throw new Error("lỗi bất ngờ không thuộc bảng mã pipeline")
    })

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.written.some((w) => w.startsWith("event: error"))).toBe(true)
    expect(outcome.written.some((w) => w.includes("NOT_IMPLEMENTED"))).toBe(true)
    expect(outcome.written.some((w) => w.includes("retryable\":false"))).toBe(true)
    expect(outcome.ended).toBe(true)
  })

  it("F7: ApiError 400 không thuộc bảng mã pipeline ⇒ quy về VALIDATION_ERROR", async () => {
    vi.mocked(runStep).mockImplementation(async (_p, stepId, _s, _u, emit) => {
      emit({ type: "intake", step_id: stepId, phase: "S-3", empty_fields: [] })
      throw new ApiError(400, "input xấu", "SOME_OTHER_MODULE_CODE")
    })

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-3.1", { session_id: "s1", base_version: 1 })

    expect(outcome.written.some((w) => w.includes("VALIDATION_ERROR"))).toBe(true)
  })

  it("AiActionError INSUFFICIENT_CREDIT giữa chừng ⇒ SSE error đúng mã, retryable (không quy về NOT_IMPLEMENTED)", async () => {
    vi.mocked(runStep).mockImplementation(async (_p, stepId, _s, _u, emit) => {
      emit({ type: "intake", step_id: stepId, phase: "S-2", empty_fields: [] })
      throw new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT")
    })

    const outcome = await invokeSse(runStepController, OWNER, PROJECT, "S-2.3", { session_id: "s1", base_version: 1 })

    expect(outcome.written.some((w) => w.includes("\"code\":\"INSUFFICIENT_CREDIT\""))).toBe(true)
    expect(outcome.written.some((w) => w.includes("retryable\":true"))).toBe(true)
  })

  it("F8: client đóng kết nối giữa chừng ⇒ AbortSignal truyền vào runStep bị abort, không ghi/end sau khi đóng", async () => {
    const written: string[] = []
    let endCalled = false
    let capturedSignal: AbortSignal | undefined
    const closeListeners: Array<() => void> = []

    const req = {
      user: { userId: OWNER },
      params: { projectId: PROJECT, stepId: "S-3.1" },
      body: { session_id: "s1", base_version: 1 },
      on: (event: string, cb: () => void) => {
        if (event === "close") closeListeners.push(cb)
      }
    } as unknown as Request
    const res = {
      writableEnded: false,
      setHeader: () => res,
      flushHeaders: () => {},
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      end: () => {
        endCalled = true
      }
    } as unknown as Response
    const next = vi.fn()

    vi.mocked(runStep).mockImplementation(async (_p, stepId, _s, _u, emit, deps) => {
      capturedSignal = deps?.signal
      emit({ type: "intake", step_id: stepId, phase: "S-3", empty_fields: [] })
      // Client đóng NGAY sau sự kiện đầu — mô phỏng đóng tab giữa chừng.
      closeListeners.forEach((cb) => cb())
      emit({ type: "elicit", step_id: stepId, delta: "sau khi đóng — KHÔNG được ghi ra res" })
    })

    runStepController(req, res, next)
    await flushMicrotasks()

    expect(capturedSignal?.aborted).toBe(true)
    expect(written.some((w) => w.startsWith("event: intake"))).toBe(true)
    expect(written.some((w) => w.includes("sau khi đóng"))).toBe(false)
    expect(endCalled).toBe(false)
    expect(next).not.toHaveBeenCalled()
  })
})

describe("GET /projects/:projectId/steps", () => {
  const invokeJson = (handler: RequestHandler, userId: string | undefined, projectId: string) =>
    new Promise<{ status: number; body: unknown; error?: unknown }>((resolve) => {
      const req = { user: userId ? { userId } : undefined, params: { projectId }, body: {} } as unknown as Request
      const res = {
        status(code: number) {
          ;(res as unknown as { _status: number })._status = code
          return res
        },
        json(body: unknown) {
          resolve({ status: (res as unknown as { _status: number })._status ?? 200, body })
          return res
        }
      } as unknown as Response
      const next: NextFunction = (err?: unknown) => resolve({ status: 0, body: null, error: err })
      handler(req, res, next)
    })

  it("F17: getOrCreate nhận {name, domain} của project (như spine.controller.ts) — không tạo Spine rỗng thiếu tên", async () => {
    vi.mocked(getOrCreate).mockResolvedValue({
      projectId: PROJECT,
      spine_version: 1,
      progress: { current_phase: null, current_step: null, elicit_turns_this_phase: 0, screen_cursor: null, screen_queue: [] },
      steps: [],
      screens: [],
      functions: []
    } as never)

    await invokeJson(getSteps, OWNER, PROJECT)

    expect(getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "Lumen", domain: "E-learning" })
  })

  it("F10: dùng roundCountsForSteps MỘT lần cho toàn bộ danh sách step, không roundCounts từng step", async () => {
    vi.mocked(getOrCreate).mockResolvedValue({
      projectId: PROJECT,
      spine_version: 1,
      progress: { current_phase: null, current_step: null, elicit_turns_this_phase: 0, screen_cursor: null, screen_queue: [] },
      steps: [],
      screens: [],
      functions: []
    } as never)

    const outcome = await invokeJson(getSteps, OWNER, PROJECT)

    expect(roundCountsForSteps).toHaveBeenCalledTimes(1)
    expect(outcome.error).toBeUndefined()
    // `current_step` là step TỚI LƯỢT (cùng luật với GET /progress), không phải con trỏ trong Spine:
    // spine rỗng ⇒ bước đầu quy trình.
    expect(outcome.body).toMatchObject({ data: { current_phase: null, current_step: "B-0.1" } })
  })
})

/** Handler JSON thường (không SSE): resolve khi `res.json` hoặc `next(err)`. */
const invokeJsonHandler = (handler: RequestHandler, userId: string, params: Record<string, string>, body: unknown = {}) =>
  new Promise<{ status: number; body: unknown; error?: unknown }>((resolve) => {
    const req = { user: { userId }, params, body } as unknown as Request
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
    handler(req, res, (err?: unknown) => resolve({ status: 0, body: null, error: err }))
  })

describe("POST /projects/:projectId/steps/:stepId/gate — session_id (contract-change 2026-09-15)", () => {
  beforeEach(() => {
    vi.mocked(requirePipelineSession).mockReset()
    vi.mocked(gate).mockReset()
  })

  it("thiếu session_id ⇒ 400 VALIDATION_ERROR, không gọi gate", async () => {
    const outcome = await invokeJsonHandler(gateStep, OWNER, { projectId: PROJECT, stepId: "S-3.1" }, { action: "accept", base_version: 1 })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(gate).not.toHaveBeenCalled()
  })

  it("session không pipeline ⇒ 403 NOT_PIPELINE_SESSION, không gọi gate", async () => {
    vi.mocked(requirePipelineSession).mockRejectedValue(new ApiError(403, "not pipeline", NOT_PIPELINE_SESSION))
    const outcome = await invokeJsonHandler(gateStep, OWNER, { projectId: PROJECT, stepId: "S-3.1" }, { session_id: "s1", action: "accept", base_version: 1 })
    expect(outcome.error).toMatchObject({ statusCode: 403, code: NOT_PIPELINE_SESSION })
    expect(gate).not.toHaveBeenCalled()
  })

  it("session pipeline hợp lệ ⇒ gọi gate và trả 200", async () => {
    vi.mocked(requirePipelineSession).mockResolvedValue(undefined)
    vi.mocked(gate).mockResolvedValue({ step: { id: "S-3.1" }, next_step: "S-3.2", spine_version: 2 } as never)
    const outcome = await invokeJsonHandler(gateStep, OWNER, { projectId: PROJECT, stepId: "S-3.1" }, { session_id: "s1", action: "accept", base_version: 1 })
    expect(requirePipelineSession).toHaveBeenCalledWith(PROJECT, "s1")
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { next_step: "S-3.2", spine_version: 2 } })
  })
})

describe("POST /projects/:projectId/steps/:stepId/answer — giới hạn độ dài", () => {
  it(`answer dài hơn ${ANSWER_MAX_CHARS} ký tự ⇒ 400 VALIDATION_ERROR`, async () => {
    const body = { session_id: "s1", answers: [{ question_id: "Q1", answer: "x".repeat(ANSWER_MAX_CHARS + 1) }] }
    const outcome = await invokeJsonHandler(answerStep, OWNER, { projectId: PROJECT, stepId: "S-3.1" }, body)
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })
})

describe("POST /projects/:projectId/resume (contract endpoint 24)", () => {
  beforeEach(() => vi.mocked(resumeProject).mockReset())

  it("trả kết quả resumeProject trong envelope", async () => {
    vi.mocked(resumeProject).mockResolvedValue({ reverted_step: "S-3.2", spine_version: 7, progress: {} } as never)
    const outcome = await invokeJsonHandler(resumeProjectController, OWNER, { projectId: PROJECT })
    expect(resumeProject).toHaveBeenCalledWith(PROJECT, OWNER)
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { reverted_step: "S-3.2", spine_version: 7 } })
  })

  it("project không thuộc user ⇒ 404, không revert", async () => {
    const outcome = await invokeJsonHandler(resumeProjectController, "650000000000000000000099", { projectId: PROJECT })
    expect(outcome.error).toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" })
    expect(resumeProject).not.toHaveBeenCalled()
  })
})
