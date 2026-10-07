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
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: vi.fn() } }))
const account = vi.hoisted(() => ({ locale: null as "vi" | "en" | null }))
vi.mock("../user/account-locale.js", () => ({ accountLocaleOf: vi.fn(async () => account.locale) }))

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
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import { accountLocaleOf } from "../user/account-locale.js"

/**
 * task-26 Pha 4: quyền truy cập dự án tính theo ORG chứ không theo người. Test cũ phân biệt "chủ dự án"
 * với "người lạ" qua userId, nên ở đây cho mỗi actor một org riêng để giữ nguyên ý định từng ca.
 */
const ORG = "650000000000000000000099"
const OTHER_ORG = "650000000000000000000097"
const orgCtxFor = (userId?: string) => ({
  orgId: userId === OWNER ? ORG : OTHER_ORG,
  role: "lead" as const,
  membershipId: "650000000000000000000098"
})


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
    const req = { orgContext: orgCtxFor(userId), user: userId ? { userId } : undefined, params: { projectId }, body, query } as unknown as Request
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
  vi.mocked(ChatSession.findById).mockReset()
  vi.mocked(accountLocaleOf).mockClear()
  account.locale = null

  vi.mocked(getProjectById).mockImplementation(async (projectId, orgId) => {
    if (projectId !== PROJECT || orgId !== ORG) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
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
    expect(changeService.apply).toHaveBeenCalledWith(PROJECT, OWNER, { base_version: 1, ops: [OP], reason: "typo", reply_language: "vi" }, INIT)
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
      { base_version: 2, instruction: "Đổi tên actor A01 thành Student", reply_language: "vi" },
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
    // FLF-247: câu theo luật vi phạm, không phải message thô của engine
    expect((outcome.body as { error: { message: string } }).error.message).toBe(
      "Không xoá được mục này vì tài liệu cần giữ ít nhất một mục ở phần đó."
    )
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
    expect(changeService.preview).toHaveBeenCalledWith(PROJECT, OWNER, { base_version: 1, instruction: "đổi tên", reply_language: "vi" }, INIT)
  })
})

describe("FLF-260 — ngôn ngữ trả lời của lượt sửa", () => {
  const SESSION = "650000000000000000000003"
  const CHANGE = { op: "set", path: "actors[id=A01].name", before: "Founder", value: "Student", reason: null }
  const APPLIED = { ...CHANGE, projectId: PROJECT, seq: 5, txn: "t3", at: "2026-10-07T00:00:00.000Z", by: OWNER, step_id: null }
  const EMPTY_IMPACT = { fields: [], sections: [], diagrams: [], referrers: [] }

  /** Phiên chat giả do `loadProjectSession` nạp; `persisted` là `reply_language` lúc `save()` — thứ thật sự xuống DB. */
  const fakeSession = (replyLanguage: "vi" | "en" | null) => {
    const session = {
      projectId: PROJECT,
      messages: [] as IChatMessage[],
      reply_language: replyLanguage,
      persisted: undefined as string | null | undefined,
      save: vi.fn(async () => {
        session.persisted = session.reply_language
      })
    }
    vi.mocked(ChatSession.findById).mockResolvedValue(session as never)
    return session
  }
  const replyOf = (message: IChatMessage) => (JSON.parse(message.content) as { kind: string; reply: string })

  it("câu lệnh tiếng Anh trong phiên ⇒ model nhận en, phiên lưu reply_language en, bong bóng xem trước tiếng Anh", async () => {
    const session = fakeSession(null)
    vi.mocked(changeService.preview).mockResolvedValue({
      ok: true,
      txn: "t",
      base_version: 1,
      ops: [OP, OP],
      changes: [CHANGE, CHANGE],
      violations: [],
      referrers: [],
      preview_id: "pv1"
    })

    const instruction = "Rename the actor A01 to Student"
    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, instruction, session_id: SESSION })

    expect(outcome.status).toBe(200)
    expect(vi.mocked(changeService.preview).mock.calls[0][2]).toMatchObject({ instruction, reply_language: "en" })
    // Một lần ghi ngôn ngữ ngay sau khi đoán, một lần ghi lượt chat
    expect(session.save).toHaveBeenCalledTimes(2)
    expect(session.persisted).toBe("en")
    expect(session.messages[0]).toMatchObject({ role: "user", content: instruction })
    expect(replyOf(session.messages[1])).toMatchObject({
      kind: "change_preview",
      reply: 'Built a preview of 2 changes — review it, then press "Áp dụng" (Apply) to save.'
    })
  })

  it("lượt gọi model lỗi (không phải ApiError, không tới lượt ghi chat) ⇒ ngôn ngữ phiên vẫn được ghi", async () => {
    const session = fakeSession("vi")
    vi.mocked(changeService.preview).mockRejectedValue(new Error("provider down"))

    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, instruction: "Rename the actor A01 to Student", session_id: SESSION })

    expect(outcome.error).toBeInstanceOf(Error)
    expect(session.persisted).toBe("en")
  })

  it("áp thẳng bằng câu lệnh tiếng Anh trong phiên tiếng Việt ⇒ phiên chuyển en; không đổi gì ⇒ câu xác nhận tiếng Anh", async () => {
    const session = fakeSession("vi")
    vi.mocked(changeService.apply).mockResolvedValue({ txn: null, spine_version: 2, changes: [], spine: SPINE_STUB, branch: "silent", impact: EMPTY_IMPACT })

    await invoke(applyChanges, OWNER, PROJECT, { base_version: 2, instruction: "Rename the actor A01 to Student", session_id: SESSION })

    expect(vi.mocked(changeService.apply).mock.calls[0][2]).toMatchObject({ reply_language: "en" })
    expect(session.persisted).toBe("en")
    expect(replyOf(session.messages[1])).toEqual({ kind: "change_applied", reply: "Confirmed: the content is unchanged.", count: 0, spine_version: 2 })
  })

  it("bấm Áp dụng bản xem trước: câu lệnh FE gửi lại không được đoán lại — giữ ngôn ngữ phiên", async () => {
    // Xem trước bằng tiếng Việt rồi user chuyển sang viết tiếng Anh (phiên en) trước khi bấm Áp dụng
    const session = fakeSession("en")
    vi.mocked(changeService.apply).mockResolvedValue({
      txn: "t3",
      spine_version: 3,
      changes: [APPLIED],
      spine: SPINE_STUB,
      branch: "dependent",
      impact: EMPTY_IMPACT
    })

    await invoke(applyChanges, OWNER, PROJECT, {
      base_version: 2,
      instruction: "Đổi tên actor A01 thành Student",
      preview_id: "pv1",
      session_id: SESSION
    })

    expect(vi.mocked(changeService.apply).mock.calls[0][2]).toMatchObject({ reply_language: "en" })
    expect(session.persisted).toBe("en")
    expect(session.messages).toHaveLength(1)
    expect(replyOf(session.messages[0])).toMatchObject({ kind: "change_applied", reply: "Applied 1 change to the document (v3)." })
  })

  it("phiên chưa có ngôn ngữ, câu lệnh tiếng Việt ⇒ bong bóng giữ nguyên tiếng Việt", async () => {
    const session = fakeSession(null)
    vi.mocked(changeService.apply).mockResolvedValue({
      txn: "t3",
      spine_version: 3,
      changes: [APPLIED],
      spine: SPINE_STUB,
      branch: "dependent",
      impact: EMPTY_IMPACT
    })

    await invoke(applyChanges, OWNER, PROJECT, { base_version: 2, instruction: "Đổi tên actor A01 thành Student", session_id: SESSION })

    expect(session.persisted).toBe("vi")
    expect(replyOf(session.messages[1]).reply).toBe("Đã áp dụng 1 thay đổi vào tài liệu (v3).")
  })

  it("không có phiên: câu lệnh rõ ngôn ngữ thắng; lô op sẵn không có chữ để đoán ⇒ ngôn ngữ tài khoản ⇒ tiếng Việt", async () => {
    vi.mocked(changeService.preview).mockResolvedValue({ ok: true, txn: "t", base_version: 1, ops: [], changes: [], violations: [], referrers: [] })

    await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, instruction: "Please rename the actor A01 to Student" })
    account.locale = "en"
    await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })
    account.locale = null
    await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, ops: [OP] })

    expect(vi.mocked(changeService.preview).mock.calls.map((call) => call[2].reply_language)).toEqual(["en", "en", "vi"])
    expect(accountLocaleOf).toHaveBeenCalledWith(OWNER)
    expect(ChatSession.findById).not.toHaveBeenCalled()
  })

  it("client không gửi được reply_language (DTO strict, không đổi hợp đồng) ⇒ 400", async () => {
    const outcome = await invoke(previewChanges, OWNER, PROJECT, { base_version: 1, instruction: "đổi tên", reply_language: "en" })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(changeService.preview).not.toHaveBeenCalled()
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
