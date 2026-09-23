import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("./spine.repository.js", () => ({ getOrCreate: vi.fn(), listChanges: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./flags.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./flags.service.js")>()
  return { ...actual, recompute: vi.fn(), waive: vi.fn() }
})

import { getFlags, getProgress, recomputeFlags, waiveFlag } from "./flags.controller.js"
import flagsRoutes from "./flags.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { getProjectById } from "../project/project.service.js"
import { getOrCreate, listChanges } from "./spine.repository.js"
import { recompute, waive } from "./flags.service.js"
import { spineSchema } from "./spine.schema.js"
import { progressResponseSchema } from "../pipeline/pipeline.dto.js"
import type { Flag } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"

const FLAGS: Flag[] = [
  { id: "FL001", level: "red", rule_id: "section_empty", section_id: "fixed:5.2", target_id: null, message: "", remediation_step: "S-7.2", opened_at_version: 1, resolved_at: null, waived_by_user: false, waive_reason: null, waived_at_version: null },
  { id: "FL002", level: "yellow", rule_id: "orphan_actor", section_id: "fixed:2.1", target_id: "A01", message: "", remediation_step: "S-3.2", opened_at_version: 1, resolved_at: null, waived_by_user: false, waive_reason: null, waived_at_version: null }
]

interface Outcome {
  status?: number
  body?: unknown
  error?: unknown
}

const invoke = (handler: RequestHandler, opts: { body?: unknown; query?: unknown; params?: Record<string, string> } = {}) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = {}
    const req = { user: { userId: OWNER }, params: { projectId: PROJECT, ...opts.params }, body: opts.body, query: opts.query ?? {} } as unknown as Request
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
  vi.mocked(getProjectById).mockReset().mockResolvedValue({ name: "FlintFlow", domain: null } as never)
  vi.mocked(getOrCreate).mockReset().mockResolvedValue({ projectId: PROJECT, ...structuredClone(FIXTURE), flags: FLAGS })
  vi.mocked(listChanges).mockReset().mockResolvedValue([])
  vi.mocked(recompute).mockReset()
  vi.mocked(waive).mockReset()
})

describe("flags.controller", () => {
  it("GET /progress trả đúng progressResponseSchema", async () => {
    const outcome = await invoke(getProgress)
    expect(outcome.status).toBe(200)
    const data = (outcome.body as { data: unknown }).data
    expect(progressResponseSchema.safeParse(data).success).toBe(true)
    // 81 = 51 + 5×6 (5 màn signed_off + vòng nonscreen); 14 màn placeholder không vào mẫu số
    expect(data).toMatchObject({ readiness: { red_open: 1 }, progress: { total: 81, show_percent: true } })
  })

  it("GET /flags lọc theo level/open; query sai ⇒ 400", async () => {
    const outcome = await invoke(getFlags, { query: { level: "red", open: "true" } })
    expect((outcome.body as { data: Flag[] }).data.map((f) => f.id)).toEqual(["FL001"])
    expect((await invoke(getFlags, { query: { level: "blue" } })).error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })

  it("POST /flags/recompute chuyển at_baseline và trả meta", async () => {
    vi.mocked(recompute).mockResolvedValue({ checked_at_version: 9, flags: FLAGS, opened: ["FL002"], resolved: [], reopened: [] })
    const outcome = await invoke(recomputeFlags, { body: { at_baseline: true } })
    expect(recompute).toHaveBeenCalledWith(PROJECT, { atBaseline: true, by: OWNER })
    expect(outcome.body).toMatchObject({ meta: { checked_at_version: 9, opened: ["FL002"] } })
  })

  it("POST /flags/:flagId/waive: lý do ngắn ⇒ 400 trước khi gọi service", async () => {
    expect((await invoke(waiveFlag, { body: { reason: "ngắn" }, params: { flagId: "FL001" } })).error).toMatchObject({ statusCode: 400 })
    expect(waive).not.toHaveBeenCalled()

    vi.mocked(waive).mockResolvedValue({ ...FLAGS[0], waived_by_user: true })
    const ok = await invoke(waiveFlag, { body: { reason: "Khách hàng chấp nhận thiếu mục này" }, params: { flagId: "FL001" } })
    expect(ok.status).toBe(200)
    expect(waive).toHaveBeenCalledWith(PROJECT, "FL001", "Khách hàng chấp nhận thiếu mục này", OWNER)
  })

  it("route: 4 endpoint kèm authMiddleware", () => {
    const expected = [
      ["/:projectId/flags", "get"],
      ["/:projectId/flags/recompute", "post"],
      ["/:projectId/flags/:flagId/waive", "post"],
      ["/:projectId/progress", "get"]
    ] as const
    for (const [p, method] of expected) {
      const layer = flagsRoutes.stack.find((l) => l.route?.path === p)
      const route = layer?.route as unknown as { methods: Record<string, boolean>; stack: { handle: unknown }[] }
      expect(route?.methods[method], p).toBe(true)
      expect(route.stack[0].handle).toBe(authMiddleware)
    }
  })
})
