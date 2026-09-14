import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./spine.repository.js", () => ({ getOrCreate: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./op-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./op-engine.js")>()
  return { ...actual, applyTransaction: vi.fn(), previewTransaction: vi.fn() }
})

import { applyChanges, previewChanges } from "./changes.controller.js"
import changesRoutes from "./changes.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { getProjectById } from "../project/project.service.js"
import { getOrCreate } from "./spine.repository.js"
import { TransactionRejectedError, applyTransaction, previewTransaction } from "./op-engine.js"
import { ApiError } from "../../shared/utils/api-error.js"

const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"
const OP = { op: "set", path: "actors[id=A01].name", value: "Student" }

interface Outcome {
  status?: number
  body?: unknown
  error?: unknown
}

const invoke = (handler: RequestHandler, userId: string | undefined, projectId: string, body: unknown) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = {}
    const req = { user: userId ? { userId } : undefined, params: { projectId }, body } as unknown as Request
    const res = {
      status(code: number) {
        outcome.status = code
        return this
      },
      json(payload: unknown) {
        outcome.body = payload
        resolve(outcome)
        return this
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
  vi.mocked(getOrCreate).mockReset()
  vi.mocked(applyTransaction).mockReset()
  vi.mocked(previewTransaction).mockReset()

  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    return { name: "Lumen", domain: null } as never
  })
})

describe("POST /projects/:projectId/changes", () => {
  it("200: gọi applyTransaction với by = user, step_id null", async () => {
    vi.mocked(applyTransaction).mockResolvedValue({ txn: "t1", spine_version: 2, changes: [], spine: { projectId: PROJECT } as never })

    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP], reason: "typo" })

    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { txn: "t1", spine_version: 2 }, error: null })
    expect(applyTransaction).toHaveBeenCalledWith(PROJECT, { base_version: 1, ops: [OP], by: OWNER, step_id: null, reason: "typo" })
    expect(getOrCreate).toHaveBeenCalledWith(PROJECT, { name: "Lumen", domain: null })
  })

  it("422: lô bị từ chối trả violations + referrers trong meta", async () => {
    vi.mocked(applyTransaction).mockRejectedValue(
      new TransactionRejectedError("INVARIANT_VIOLATION", [{ rule: "invariant_2_last_element", message: "x", path: "actors" }], [{ path: "screens[id=S1].feature_id", id: "F1" }])
    )

    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })

    expect(outcome.status).toBe(422)
    expect(outcome.body).toMatchObject({
      data: null,
      error: { code: "INVARIANT_VIOLATION" },
      meta: { violations: [{ rule: "invariant_2_last_element" }], referrers: [{ id: "F1" }] }
    })
  })

  it("409 từ engine đi qua error handler", async () => {
    vi.mocked(applyTransaction).mockRejectedValue(new ApiError(409, "conflict", "SPINE_VERSION_CONFLICT"))
    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })
    expect(outcome.error).toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
  })

  it("400 body sai; 501 instruction; 404 không sở hữu; 401 thiếu user", async () => {
    expect((await invoke(applyChanges, OWNER, PROJECT, { ops: [OP] })).error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect((await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [{ op: "migrate", path: "$", value: {} }] })).error).toMatchObject({ statusCode: 400 })
    expect((await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, instruction: "Đổi tên" })).error).toMatchObject({ statusCode: 501, code: "NOT_IMPLEMENTED" })
    expect((await invoke(applyChanges, "650000000000000000000099", PROJECT, { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 404 })
    expect((await invoke(applyChanges, OWNER, "bad-id", { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 404 })
    expect((await invoke(applyChanges, undefined, PROJECT, { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 401 })
    expect(applyTransaction).not.toHaveBeenCalled()
  })

  it("kiểm quyền sở hữu trước body: người ngoài gửi body sai vẫn nhận 404", async () => {
    const outcome = await invoke(applyChanges, "650000000000000000000099", PROJECT, { nonsense: true })
    expect(outcome.error).toMatchObject({ statusCode: 404 })
  })

  it("422 path_not_writable khi sửa gốc hệ thống quản lý; không tạo Spine, không gọi engine", async () => {
    const outcome = await invoke(applyChanges, OWNER, PROJECT, {
      base_version: 1,
      ops: [OP, { op: "set", path: "flags[id=FL001].resolved_at", value: null }, { op: "set", path: "progress.current_step", value: "S-9.5" }]
    })
    expect(outcome.status).toBe(422)
    expect(outcome.body).toMatchObject({
      error: { code: "OP_INVALID" },
      meta: { violations: [{ rule: "path_not_writable", op_index: 1 }, { rule: "path_not_writable", op_index: 2 }] }
    })
    expect(getOrCreate).not.toHaveBeenCalled()
    expect(applyTransaction).not.toHaveBeenCalled()
  })
})

describe("POST /projects/:projectId/changes/preview", () => {
  it("200 trả kết quả preview, không tạo Spine", async () => {
    vi.mocked(previewTransaction).mockResolvedValue({ ok: false, txn: "t", base_version: 1, ops: [], changes: [], violations: [], referrers: [] })
    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { ok: false } })
    expect(previewTransaction).toHaveBeenCalledWith(PROJECT, { base_version: 1, ops: [OP], by: OWNER, step_id: null }, { name: "Lumen", domain: null })
    expect(getOrCreate).not.toHaveBeenCalled()
  })

  it("gốc hệ thống quản lý ⇒ ok=false với path_not_writable", async () => {
    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, ops: [{ op: "remove", path: "sections[id=feature:F1]" }] })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { ok: false, violations: [{ rule: "path_not_writable", op_index: 0 }] } })
    expect(previewTransaction).not.toHaveBeenCalled()
  })
})

describe("changes.route", () => {
  it("đăng ký 2 route POST kèm authMiddleware", () => {
    for (const path of ["/:projectId/changes", "/:projectId/changes/preview"]) {
      const layer = changesRoutes.stack.find((l) => l.route?.path === path)
      expect(layer, path).toBeDefined()
      const route = layer?.route as unknown as { methods: Record<string, boolean>; stack: { handle: unknown }[] }
      expect(route.methods.post).toBe(true)
      expect(route.stack[0].handle).toBe(authMiddleware)
    }
  })
})
