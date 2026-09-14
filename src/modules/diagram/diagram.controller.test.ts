import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./diagram.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diagram.service.js")>()
  return { ...actual, renderDiagram: vi.fn(), renderAll: vi.fn(), loadDiagramFile: vi.fn() }
})

import { getDiagramFile, listDiagrams, renderDiagramRoute } from "./diagram.controller.js"
import diagramRoutes from "./diagram.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { getProjectById } from "../project/project.service.js"
import { createEmptySpine, getOrCreate } from "../spine/spine.repository.js"
import { loadDiagramFile, renderAll, renderDiagram } from "./diagram.service.js"
import type { Diagram } from "../spine/spine.types.js"

vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, getOrCreate: vi.fn() }
})

const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"
const DIAGRAM: Diagram = {
  id: "D01",
  kind: "context",
  puml: "@startuml\n@enduml\n",
  section: "fixed:1",
  owner_kind: null,
  owner_id: null,
  render_status: "ok",
  source_hash: "TBD",
  rendered_at: null
}

interface Outcome {
  status?: number
  body?: unknown
  headers: Record<string, string>
  error?: unknown
}

const invoke = (handler: RequestHandler, params: Record<string, string> = {}, body: unknown = {}) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = { headers: {} }
    const req = { user: { userId: OWNER }, params: { projectId: PROJECT, ...params }, body } as unknown as Request
    const res = {
      status(code: number) {
        outcome.status = code
        return this
      },
      setHeader(k: string, v: string) {
        outcome.headers[k] = v
      },
      json(payload: unknown) {
        outcome.body = payload
        resolve(outcome)
        return this
      },
      send(payload: unknown) {
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
  vi.mocked(getOrCreate).mockReset().mockResolvedValue({ projectId: PROJECT, ...createEmptySpine({ name: "FlintFlow" }), diagrams: [DIAGRAM] })
  vi.mocked(renderDiagram).mockReset()
  vi.mocked(renderAll).mockReset()
  vi.mocked(loadDiagramFile).mockReset()
})

describe("diagram.controller", () => {
  it("GET /diagrams: kèm stale và đường dẫn file", async () => {
    const outcome = await invoke(listDiagrams)
    expect(outcome.body).toMatchObject({
      data: [{ id: "D01", stale: true, files: { svg: `/api/v1/projects/${PROJECT}/diagrams/D01.svg` } }]
    })
  })

  it("GET /diagrams/:file: trả bytes với content-type; sai định dạng hoặc id lạ ⇒ 404", async () => {
    vi.mocked(loadDiagramFile).mockResolvedValue({ data: Buffer.from("<svg/>"), contentType: "image/svg+xml" })
    const ok = await invoke(getDiagramFile, { file: "D01.svg" })
    expect(ok.status).toBe(200)
    expect(ok.headers["Content-Type"]).toBe("image/svg+xml")
    expect(loadDiagramFile).toHaveBeenCalledWith(PROJECT, "D01", "svg")

    expect((await invoke(getDiagramFile, { file: "D01.gif" })).error).toMatchObject({ statusCode: 404, code: "DIAGRAM_NOT_FOUND" })
    expect((await invoke(getDiagramFile, { file: "D99.svg" })).error).toMatchObject({ statusCode: 404 })
  })

  it("POST /diagrams/:kind/render: kind lạ 400, screen_layout thiếu owner 400, all gọi renderAll", async () => {
    expect((await invoke(renderDiagramRoute, { kind: "sequence" })).error).toMatchObject({ statusCode: 400 })
    expect((await invoke(renderDiagramRoute, { kind: "screen_layout" })).error).toMatchObject({ statusCode: 400 })

    vi.mocked(renderAll).mockResolvedValue({ spine_version: 3, diagrams: [], rendered: [], removed: [] })
    expect((await invoke(renderDiagramRoute, { kind: "all" })).status).toBe(200)
    expect(renderAll).toHaveBeenCalledWith(PROJECT, { by: OWNER })

    vi.mocked(renderDiagram).mockResolvedValue({ spine_version: 4, diagrams: [], rendered: [], removed: [] })
    await invoke(renderDiagramRoute, { kind: "screen_layout" }, { owner_id: "S07" })
    expect(renderDiagram).toHaveBeenCalledWith(PROJECT, "screen_layout", "S07", { by: OWNER })
  })

  it("route: 3 endpoint kèm authMiddleware", () => {
    for (const [p, method] of [
      ["/:projectId/diagrams", "get"],
      ["/:projectId/diagrams/:file", "get"],
      ["/:projectId/diagrams/:kind/render", "post"]
    ] as const) {
      const route = diagramRoutes.stack.find((l) => l.route?.path === p)?.route as unknown as { methods: Record<string, boolean>; stack: { handle: unknown }[] }
      expect(route?.methods[method], p).toBe(true)
      expect(route.stack[0].handle).toBe(authMiddleware)
    }
  })
})
