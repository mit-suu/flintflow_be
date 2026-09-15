import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./assemble.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assemble.service.js")>()
  return { ...actual, assemble: vi.fn(), getDocument: vi.fn(), getDraftMeta: vi.fn() }
})
vi.mock("./docx-writer.js", () => ({ writeDocx: vi.fn(), buildDocxFileName: vi.fn(() => "demo-v0.1-draft.docx") }))

import { assembleController, getDocumentController } from "./render.controller.js"
import { exportWord } from "./export.controller.js"
import { getProjectById } from "../project/project.service.js"
import { assemble, getDocument, getDraftMeta, NoWorkingDraftError } from "./assemble.service.js"
import { writeDocx } from "./docx-writer.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { RenderedDocument } from "./rendered-document.types.js"

const OWNER = "650000000000000000000010"
const PROJECT = "650000000000000000000001"

interface Outcome {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  sent?: Buffer
  error?: unknown
}

const invoke = (handler: RequestHandler, userId: string | undefined, projectId: string, query: Record<string, unknown> = {}, body: unknown = {}) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = { headers: {} }
    const req = { user: userId ? { userId } : undefined, params: { projectId }, query, body } as unknown as Request
    const res = {
      status(code: number) {
        outcome.status = code
        return this
      },
      setHeader(name: string, value: string) {
        outcome.headers![name.toLowerCase()] = value
        return this
      },
      json(payload: unknown) {
        outcome.body = payload
        resolve(outcome)
        return this
      },
      send(payload: Buffer) {
        outcome.sent = payload
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
  vi.mocked(assemble).mockReset()
  vi.mocked(getDocument).mockReset()
  vi.mocked(getDraftMeta).mockReset()
  vi.mocked(getDraftMeta).mockResolvedValue(null)
  vi.mocked(writeDocx).mockReset()

  vi.mocked(getProjectById).mockImplementation(async (projectId, userId) => {
    if (projectId !== PROJECT || userId !== OWNER) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    return { name: "Demo", domain: null } as never
  })
})

describe("POST /projects/:projectId/assemble", () => {
  it("200: gọi assemble(projectId, projectName, base_version)", async () => {
    vi.mocked(assemble).mockResolvedValue({ spine_version: 3, sections: 10, generated_at: "2026-09-15T00:00:00.000Z", findings: [] })
    const outcome = await invoke(assembleController, OWNER, PROJECT, {}, { base_version: 3 })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { spine_version: 3, sections: 10 }, error: null })
    expect(assemble).toHaveBeenCalledWith(PROJECT, "Demo", 3)
  })

  it("400 body sai; 404 không sở hữu; 401 thiếu user", async () => {
    expect((await invoke(assembleController, OWNER, PROJECT, {}, {})).error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect((await invoke(assembleController, "650000000000000000000099", PROJECT, {}, { base_version: 1 })).error).toMatchObject({ statusCode: 404 })
    expect((await invoke(assembleController, undefined, PROJECT, {}, { base_version: 1 })).error).toMatchObject({ statusCode: 401 })
    expect(assemble).not.toHaveBeenCalled()
  })

  it("409 từ service đi qua error handler", async () => {
    vi.mocked(assemble).mockRejectedValue(new ApiError(409, "conflict", "SPINE_VERSION_CONFLICT"))
    const outcome = await invoke(assembleController, OWNER, PROJECT, {}, { base_version: 1 })
    expect(outcome.error).toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
  })
})

describe("GET /projects/:projectId/document", () => {
  it("200: trả RenderedDocument", async () => {
    const doc = { projectId: PROJECT, projectName: "Demo" } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: { projectId: PROJECT }, error: null })
    expect(getDocument).toHaveBeenCalledWith(PROJECT, "Demo", { source: "draft" })
  })

  it("409 NO_WORKING_DRAFT kèm meta.hint = S-8.2 khi chưa assemble", async () => {
    vi.mocked(getDocument).mockRejectedValue(new NoWorkingDraftError())
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(409)
    expect(outcome.body).toMatchObject({ error: { code: "NO_WORKING_DRAFT" }, meta: { hint: "S-8.2" } })
  })

  it("404 BASELINE_NOT_FOUND đi qua error handler (không phải NoWorkingDraftError)", async () => {
    vi.mocked(getDocument).mockRejectedValue(new ApiError(404, "not found", "BASELINE_NOT_FOUND"))
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline" })
    expect(outcome.error).toMatchObject({ statusCode: 404, code: "BASELINE_NOT_FOUND" })
  })

  it("review C2: source=draft đính kèm meta.assembled_at_version/spine_version/stale", async () => {
    const doc = { projectId: PROJECT, projectName: "Demo" } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    vi.mocked(getDraftMeta).mockResolvedValue({ assembled_at_version: 3, spine_version: 5, stale: true })
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
    expect(outcome.body).toMatchObject({ meta: { assembled_at_version: 3, spine_version: 5, stale: true } })
  })

  it("review C2: source=baseline không gọi getDraftMeta, không có meta", async () => {
    const doc = { projectId: PROJECT, projectName: "Demo" } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline" })
    expect(getDraftMeta).not.toHaveBeenCalled()
    expect(outcome.body).toMatchObject({ data: { projectId: PROJECT } })
    expect((outcome.body as { meta?: unknown }).meta).toBeUndefined()
  })
})

describe("GET /projects/:projectId/export/word", () => {
  it("200: docx attachment, không bọc envelope", async () => {
    const doc = { projectName: "Demo", version: "v0.1", source: "draft", watermark: "DRAFT", sections: [], recordOfChanges: [], generatedAt: "2026-09-15T00:00:00.000Z", projectId: PROJECT } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    vi.mocked(writeDocx).mockResolvedValue(Buffer.from("PK-fake-docx"))

    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "draft" })
    expect(outcome.status).toBe(200)
    expect(outcome.headers?.["content-disposition"]).toContain("attachment")
    expect(outcome.sent?.toString()).toBe("PK-fake-docx")
  })

  it("review C2: source=draft thêm header X-Assembled-At-Version / X-Spine-Version", async () => {
    const doc = { projectName: "Demo", version: "v0.1", source: "draft", watermark: "DRAFT", sections: [], recordOfChanges: [], generatedAt: "2026-09-15T00:00:00.000Z", projectId: PROJECT } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    vi.mocked(writeDocx).mockResolvedValue(Buffer.from("PK-fake-docx"))
    vi.mocked(getDraftMeta).mockResolvedValue({ assembled_at_version: 4, spine_version: 6, stale: true })

    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "draft" })
    expect(outcome.headers?.["x-assembled-at-version"]).toBe("4")
    expect(outcome.headers?.["x-spine-version"]).toBe("6")
  })

  it("review C2: source=baseline không gọi getDraftMeta, không có header phiên bản", async () => {
    const doc = { projectName: "Demo", version: "v1.0", source: "baseline", sections: [], recordOfChanges: [], generatedAt: "2026-09-15T00:00:00.000Z", projectId: PROJECT } as unknown as RenderedDocument
    vi.mocked(getDocument).mockResolvedValue(doc)
    vi.mocked(writeDocx).mockResolvedValue(Buffer.from("PK-fake-docx"))

    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "baseline" })
    expect(getDraftMeta).not.toHaveBeenCalled()
    expect(outcome.headers?.["x-assembled-at-version"]).toBeUndefined()
  })

  it("409 NO_WORKING_DRAFT kèm meta.hint = S-8.2 khi chưa assemble", async () => {
    vi.mocked(getDocument).mockRejectedValue(new NoWorkingDraftError())
    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "draft" })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(409)
    expect(outcome.body).toMatchObject({ error: { code: "NO_WORKING_DRAFT" }, meta: { hint: "S-8.2" } })
  })

  it("400 khi source query sai (không thuộc draft|baseline)", async () => {
    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "nope" })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })
})
