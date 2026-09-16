import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./spine.repository.js", () => ({
  get: vi.fn(),
  listChanges: vi.fn(),
  SPINE_NOT_FOUND: "SPINE_NOT_FOUND"
}))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./change.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./change.service.js")>()
  return { ...actual, apply: vi.fn(), preview: vi.fn() }
})
vi.mock("./reconcile.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reconcile.service.js")>()
  return { ...actual, reconcile: vi.fn() }
})
vi.mock("./undo.service.js", () => ({ undoLast: vi.fn(), NOTHING_TO_UNDO: "NOTHING_TO_UNDO" }))

import {
  applyChanges,
  getTraceability,
  listChanges,
  previewChanges,
  reconcileChanges,
  undoLastChange
} from "./changes.controller.js"
import changesRoutes from "./changes.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { getProjectById } from "../project/project.service.js"
import * as spineRepository from "./spine.repository.js"
import * as changeService from "./change.service.js"
import * as reconcileService from "./reconcile.service.js"
import * as undoService from "./undo.service.js"
import { TransactionRejectedError } from "./op-engine.js"
import { ApiError } from "../../shared/utils/api-error.js"

const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"
const OP = { op: "set" as const, path: "actors[id=A01].name", value: "Student" }
const INIT = { name: "Lumen", domain: null }

const SPINE_STUB = { projectId: PROJECT, spine_version: 2 } as never

interface Outcome {
  status?: number
  body?: unknown
  error?: unknown
}

const invoke = (handler: RequestHandler, userId: string | undefined, projectId: string, body: unknown, query: unknown = {}) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = {}
    const req = { user: userId ? { userId } : undefined, params: { projectId }, body, query } as unknown as Request
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
  vi.mocked(changeService.apply).mockReset()
  vi.mocked(changeService.preview).mockReset()
  vi.mocked(reconcileService.reconcile).mockReset()
  vi.mocked(undoService.undoLast).mockReset()
  vi.mocked(spineRepository.get).mockReset()
  vi.mocked(spineRepository.listChanges).mockReset()

  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    return { name: "Lumen", domain: null } as never
  })
})

describe("POST /projects/:projectId/changes", () => {
  it("200: gọi change.service.apply với userId, init; meta mang branch + impact", async () => {
    vi.mocked(changeService.apply).mockResolvedValue({
      txn: "t1",
      spine_version: 2,
      changes: [],
      spine: SPINE_STUB,
      branch: "dependent",
      impact: { fields: ["actors[id=A01].name"], sections: [{ id: "fixed:2.1", relation: "owner" }], diagrams: ["usecase"], referrers: [] }
    })

    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP], reason: "typo" })

    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({
      data: { txn: "t1", spine_version: 2 },
      meta: { branch: "dependent", impact: { diagrams: ["usecase"] } },
      error: null
    })
    expect(changeService.apply).toHaveBeenCalledWith(PROJECT, OWNER, { base_version: 1, ops: [OP], reason: "typo" }, INIT)
  })

  it("nhánh instruction đi tiếp xuống service (không còn 501 NOT_IMPLEMENTED)", async () => {
    vi.mocked(changeService.apply).mockResolvedValue({
      txn: "t2",
      spine_version: 3,
      changes: [],
      spine: SPINE_STUB,
      branch: "silent",
      impact: { fields: [], sections: [], diagrams: [], referrers: [] }
    })

    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 2, instruction: "Đổi tên actor A01 thành Student" })

    expect(outcome.status).toBe(200)
    expect(changeService.apply).toHaveBeenCalledWith(
      PROJECT,
      OWNER,
      { base_version: 2, instruction: "Đổi tên actor A01 thành Student" },
      INIT
    )
  })

  it("409 NEEDS_CLARIFICATION: câu hỏi làm rõ đi trong meta", async () => {
    vi.mocked(changeService.apply).mockRejectedValue(new changeService.NeedsClarificationError("Actor nào — A01 hay A03?"))

    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, instruction: "Đổi tên admin" })

    expect(outcome.status).toBe(409)
    expect(outcome.body).toMatchObject({
      data: null,
      error: { code: "NEEDS_CLARIFICATION" },
      meta: { clarification: "Actor nào — A01 hay A03?" }
    })
  })

  it("422: lô bị từ chối trả violations + referrers trong meta", async () => {
    vi.mocked(changeService.apply).mockRejectedValue(
      new TransactionRejectedError("INVARIANT_VIOLATION", [{ rule: "invariant_2_last_element", message: "x", path: "actors" }], [
        { path: "screens[id=S1].feature_id", id: "F1" }
      ])
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
    vi.mocked(changeService.apply).mockRejectedValue(new ApiError(409, "conflict", "SPINE_VERSION_CONFLICT"))
    const outcome = await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })
    expect(outcome.error).toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
  })

  it("400 body sai; 404 không sở hữu; 401 thiếu user — service không được gọi", async () => {
    expect((await invoke(applyChanges, OWNER, PROJECT, { ops: [OP] })).error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect((await invoke(applyChanges, OWNER, PROJECT, { base_version: 1 })).error).toMatchObject({ statusCode: 400 })
    expect((await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [OP], instruction: "cả hai" })).error).toMatchObject({
      statusCode: 400
    })
    expect((await invoke(applyChanges, OWNER, PROJECT, { base_version: 1, ops: [{ op: "migrate", path: "$", value: {} }] })).error).toMatchObject({
      statusCode: 400
    })
    expect((await invoke(applyChanges, "650000000000000000000099", PROJECT, { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 404 })
    expect((await invoke(applyChanges, OWNER, "bad-id", { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 404 })
    expect((await invoke(applyChanges, undefined, PROJECT, { base_version: 1, ops: [OP] })).error).toMatchObject({ statusCode: 401 })
    expect(changeService.apply).not.toHaveBeenCalled()
  })

  it("kiểm quyền sở hữu trước body: người ngoài gửi body sai vẫn nhận 404", async () => {
    const outcome = await invoke(applyChanges, "650000000000000000000099", PROJECT, { nonsense: true })
    expect(outcome.error).toMatchObject({ statusCode: 404 })
  })
})

describe("POST /projects/:projectId/changes/preview", () => {
  it("200 trả nguyên kết quả preview kể cả khi ok=false", async () => {
    vi.mocked(changeService.preview).mockResolvedValue({
      ok: false,
      txn: "t",
      base_version: 1,
      ops: [],
      changes: [],
      violations: [],
      referrers: [],
      clarification: "Ý bạn là actor nào?"
    })

    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, instruction: "đổi tên" })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { ok: false, clarification: "Ý bạn là actor nào?" } })
    expect(changeService.preview).toHaveBeenCalledWith(PROJECT, OWNER, { base_version: 1, instruction: "đổi tên" }, INIT)
  })
})

describe("POST /projects/:projectId/reconcile", () => {
  it("lượt 1 trả preview gộp nguyên vẹn", async () => {
    vi.mocked(reconcileService.reconcile).mockResolvedValue({
      ok: true,
      txn: "t",
      base_version: 4,
      ops: [OP],
      changes: [],
      violations: [],
      referrers: [],
      preview_id: "pv1"
    })

    const outcome = await invoke(reconcileChanges, OWNER, PROJECT, { base_version: 4 })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { preview_id: "pv1", ok: true } })
  })

  it("lượt 2 (preview_id) trả kết quả đã áp", async () => {
    vi.mocked(reconcileService.reconcile).mockResolvedValue({
      txn: "t9",
      spine_version: 7,
      changes: [],
      spine: SPINE_STUB,
      branch: "dependent",
      impact: { fields: [], sections: [], diagrams: [], referrers: [] }
    })

    const outcome = await invoke(reconcileChanges, OWNER, PROJECT, { base_version: 6, preview_id: "pv1" })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { txn: "t9", spine_version: 7 }, meta: { branch: "dependent" } })
  })

  it("400 khi body thừa field ngoài DTO", async () => {
    const outcome = await invoke(reconcileChanges, OWNER, PROJECT, { base_version: 4, ops: [OP] })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(reconcileService.reconcile).not.toHaveBeenCalled()
  })
})

describe("POST /projects/:projectId/undo", () => {
  it("200 trả lô revert", async () => {
    vi.mocked(undoService.undoLast).mockResolvedValue({ txn: "u1", spine_version: 5, changes: [], spine: SPINE_STUB })
    const outcome = await invoke(undoLastChange, OWNER, PROJECT, { base_version: 4 })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { txn: "u1", spine_version: 5 } })
    expect(undoService.undoLast).toHaveBeenCalledWith(PROJECT, OWNER, { base_version: 4 })
  })

  it("422 NOTHING_TO_UNDO đi qua error handler", async () => {
    vi.mocked(undoService.undoLast).mockRejectedValue(new ApiError(422, "hết", "NOTHING_TO_UNDO"))
    const outcome = await invoke(undoLastChange, OWNER, PROJECT, { base_version: 4 })
    expect(outcome.error).toMatchObject({ statusCode: 422, code: "NOTHING_TO_UNDO" })
  })
})

describe("GET /projects/:projectId/changes", () => {
  it("truyền from/to xuống repository, trả mảng change", async () => {
    vi.mocked(spineRepository.listChanges).mockResolvedValue([{ seq: 3 } as never])
    const outcome = await invoke(listChanges, OWNER, PROJECT, {}, { from: "2", to: "9" })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: [{ seq: 3 }] })
    expect(spineRepository.listChanges).toHaveBeenCalledWith(PROJECT, { fromSeq: 2, toSeq: 9 })
  })

  it("không có query ⇒ lấy toàn bộ", async () => {
    vi.mocked(spineRepository.listChanges).mockResolvedValue([])
    await invoke(listChanges, OWNER, PROJECT, {}, {})
    expect(spineRepository.listChanges).toHaveBeenCalledWith(PROJECT, {})
  })
})

describe("GET /projects/:projectId/traceability", () => {
  it("200 trả nodes + edges từ Spine", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue({
      projectId: PROJECT,
      spine_version: 1,
      actors: [{ id: "A01", name: "Founder", kind: "human", description: "" }],
      roles: [],
      use_cases: [],
      permissions: [],
      screens: [],
      functions: [],
      features: [],
      entities: [],
      nfrs: [],
      business_rules: [],
      messages: [],
      diagrams: [],
      addendum: [],
      flags: [],
      assumptions: [],
      sections: [],
      baselines: [],
      glossary: [],
      common_requirements: [],
      other_requirements: [],
      steps: [],
      progress: { current_phase: null, current_step: null, screen_cursor: null, screen_queue: [], elicit_turns_this_phase: 0 }
    } as never)

    const outcome = await invoke(getTraceability, OWNER, PROJECT, {}, { entity: "actor", id: "A01" })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { nodes: [{ kind: "actor", id: "A01", label: "Founder" }], edges: [] } })
  })

  it("400 khi entity không thuộc 8 loại", async () => {
    const outcome = await invoke(getTraceability, OWNER, PROJECT, {}, { entity: "role", id: "R1" })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })

  it("404 khi project chưa có Spine", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(null)
    const outcome = await invoke(getTraceability, OWNER, PROJECT, {}, { entity: "actor", id: "A01" })
    expect(outcome.error).toMatchObject({ statusCode: 404, code: "SPINE_NOT_FOUND" })
  })
})

describe("changes.route", () => {
  it("đăng ký đủ 6 route kèm authMiddleware", () => {
    const expected: [string, "post" | "get"][] = [
      ["/:projectId/changes", "post"],
      ["/:projectId/changes/preview", "post"],
      ["/:projectId/reconcile", "post"],
      ["/:projectId/undo", "post"],
      ["/:projectId/changes", "get"],
      ["/:projectId/traceability", "get"]
    ]
    for (const [path, method] of expected) {
      const layer = changesRoutes.stack.find((l) => {
        const route = l.route as unknown as { path: string; methods: Record<string, boolean> } | undefined
        return route?.path === path && route.methods[method] === true
      })
      expect(layer, `${method.toUpperCase()} ${path}`).toBeDefined()
      const route = layer?.route as unknown as { stack: { handle: unknown }[] }
      expect(route.stack[0].handle).toBe(authMiddleware)
    }
  })
})
