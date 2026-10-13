import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextFunction, Request, RequestHandler, Response } from "express"

vi.mock("../project/project.service.js", () => ({ getProjectById: vi.fn() }))
vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))
vi.mock("./assemble.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assemble.service.js")>()
  return { ...actual, assemble: vi.fn(), getDocument: vi.fn(), getDocumentWithMeta: vi.fn(), getDraftMeta: vi.fn() }
})
// FLF-265: mode 1 đọc `TemplateProfile.language` — model giả, không nối Mongo
vi.mock("../import/template-profile.model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../import/template-profile.model.js")>()
  return { ...actual, TemplateProfile: { findOne: vi.fn() } }
})
// FLF-265 §3.6: đường đọc tài liệu không bao giờ gọi model
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))
vi.mock("./docx-writer.js", () => ({ writeDocx: vi.fn(), buildDocxFileName: vi.fn(() => "demo-v0.1-draft.docx") }))

import { assembleController, getDocumentController } from "./render.controller.js"
import { exportWord } from "./export.controller.js"
import { getProjectById } from "../project/project.service.js"
import { assemble, getDocument, getDocumentWithMeta, getDraftMeta, NoWorkingDraftError } from "./assemble.service.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { writeDocx } from "./docx-writer.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { documentTranslationMetaSchema } from "../pipeline/pipeline.dto.js"
import { readFileSync } from "node:fs"

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
    const req = { orgContext: orgCtxFor(userId), user: userId ? { userId } : undefined, params: { projectId }, query, body } as unknown as Request
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
  vi.mocked(executeAiAction).mockReset()
  vi.mocked(TemplateProfile.findOne).mockReset()
  // FLF-265: controller gọi getDocumentWithMeta — mặc định chuyển sang mock getDocument để các ca cũ giữ nguyên
  vi.mocked(getDocumentWithMeta).mockReset()
  vi.mocked(getDocumentWithMeta).mockImplementation(async (...args) => ({ doc: await vi.mocked(getDocument)(...args) }))

  vi.mocked(getProjectById).mockImplementation(async (projectId, orgId) => {
    if (projectId !== PROJECT || orgId !== ORG) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
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
    // FLF-265: project không có documentLanguage (dự án cũ, mode 2) ⇒ en/en — đường cache như trước
    expect(getDocument).toHaveBeenCalledWith(PROJECT, "Demo", { source: "draft", languages: { locale: "en", source: "en" } })
  })

  it("FLF-177 BUG-31: chưa ghép bản nháp ⇒ 200 { state: not_assembled }, không phải lỗi 409", async () => {
    vi.mocked(getDocument).mockRejectedValue(new NoWorkingDraftError())
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ data: null, meta: { state: "not_assembled" } })
  })

  it("source=baseline chưa có bản dựng vẫn là lỗi thật 409 NO_WORKING_DRAFT", async () => {
    vi.mocked(getDocument).mockRejectedValue(new NoWorkingDraftError())
    const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline" })
    expect(outcome.status).toBe(409)
    expect(outcome.body).toMatchObject({ error: { code: "NO_WORKING_DRAFT" } })
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

  it("409 NO_WORKING_DRAFT khi project chưa có nội dung để dựng", async () => {
    vi.mocked(getDocument).mockRejectedValue(new NoWorkingDraftError())
    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "draft" })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(409)
    expect(outcome.body).toMatchObject({ error: { code: "NO_WORKING_DRAFT" } })
  })

  it("400 khi source query sai (không thuộc draft|baseline)", async () => {
    const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "nope" })
    expect(outcome.error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
  })
})

describe("FLF-265 §3.1 — ngôn ngữ tài liệu theo project", () => {
  const sample = renderedDocumentSchema.parse(
    JSON.parse(readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8"))
  ) as RenderedDocument
  const VI_PROJECT = { name: "Demo", mode: "fpt", documentLanguage: "vi" }
  const translation = { locale: "vi" as const, source_locale: "en" as const, missing: 7 }

  const asProject = (project: Record<string, unknown>) =>
    vi.mocked(getProjectById).mockImplementation(async (projectId, orgId) => {
      if (projectId !== PROJECT || orgId !== ORG) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
      return project as never
    })
  /** Mode 1: ngôn ngữ file upload. */
  const withTemplateLanguage = (language: string) =>
    vi.mocked(TemplateProfile.findOne).mockReturnValue({ lean: async () => ({ language }) } as never)

  describe("GET /document", () => {
    it("mode 2 vi, draft ⇒ languages vi/en, meta.translation + độ mới của bản vừa dựng (không đọc cache)", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockResolvedValue({
        doc: sample,
        translation,
        draftMeta: { assembled_at_version: 5, spine_version: 5, stale: false }
      })

      const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
      expect(outcome.status).toBe(200)
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "draft", languages: { locale: "vi", source: "en" } })
      expect(getDraftMeta).not.toHaveBeenCalled()
      const body = outcome.body as { data: unknown; meta: Record<string, unknown> }
      expect(body.meta).toEqual({ assembled_at_version: 5, spine_version: 5, stale: false, translation })
      expect(documentTranslationMetaSchema.parse(body.meta.translation)).toEqual(translation)
      // RenderedDocument không đổi khuôn: data qua schema strict
      expect(renderedDocumentSchema.safeParse(body.data).success).toBe(true)
      expect(TemplateProfile.findOne).not.toHaveBeenCalled()
    })

    it("mode 2 vi, baseline ⇒ chỉ meta.translation", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample, translation: { ...translation, missing: 0 } })

      const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline", baseline_id: "B1" })
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "baseline", baseline_id: "B1", languages: { locale: "vi", source: "en" } })
      expect(getDraftMeta).not.toHaveBeenCalled()
      expect((outcome.body as { meta: unknown }).meta).toEqual({ translation: { ...translation, missing: 0 } })
    })

    it("?lang=en trên dự án vi bị bỏ qua — ngôn ngữ vẫn theo project", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample, translation })

      await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline", lang: "en" })
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "baseline", languages: { locale: "vi", source: "en" } })
    })

    it("mode 2 en ⇒ không có meta.translation, độ mới vẫn từ getDraftMeta như trước", async () => {
      asProject({ name: "Demo", mode: "fpt", documentLanguage: "en" })
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample })
      vi.mocked(getDraftMeta).mockResolvedValue({ assembled_at_version: 3, spine_version: 4, stale: true })

      const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft", lang: "vi" })
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "draft", languages: { locale: "en", source: "en" } })
      expect((outcome.body as { meta: unknown }).meta).toEqual({ assembled_at_version: 3, spine_version: 4, stale: true })
    })

    it("ngôn ngữ theo documentLanguage, không theo mode: mode 1 lấy ngôn ngữ file", async () => {
      asProject({ name: "Demo", mode: "import" })
      withTemplateLanguage("vi")
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample })

      await invoke(getDocumentController, OWNER, PROJECT, { source: "baseline" })
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "baseline", languages: { locale: "vi", source: "vi" } })
    })

    it("not_assembled giữ nguyên với dự án vi", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockRejectedValue(new NoWorkingDraftError())
      const outcome = await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
      expect(outcome.status).toBe(200)
      expect(outcome.body).toMatchObject({ data: null, meta: { state: "not_assembled" } })
    })
  })

  describe("GET /export/word", () => {
    beforeEach(() => {
      vi.mocked(writeDocx).mockResolvedValue(Buffer.from("PK-fake-docx"))
    })

    it("mode 2 vi ⇒ writer vi, X-Document-Language: vi, phiên bản từ bản vừa dựng", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockResolvedValue({
        doc: sample,
        translation,
        draftMeta: { assembled_at_version: 9, spine_version: 9, stale: false }
      })

      const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "draft", lang: "en" })
      expect(outcome.status).toBe(200)
      expect(getDocumentWithMeta).toHaveBeenCalledWith(PROJECT, "Demo", { source: "draft", languages: { locale: "vi", source: "en" } })
      expect(writeDocx).toHaveBeenCalledWith(expect.anything(), { language: "vi", flagLanguage: "vi" })
      expect(outcome.headers?.["x-document-language"]).toBe("vi")
      expect(outcome.headers?.["x-assembled-at-version"]).toBe("9")
      expect(outcome.headers?.["x-spine-version"]).toBe("9")
      expect(getDraftMeta).not.toHaveBeenCalled()
    })

    it("mode 2 en ⇒ writer en (= mặc định cũ), header en", async () => {
      asProject({ name: "Demo", mode: "fpt" })
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample })

      const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "baseline" })
      expect(writeDocx).toHaveBeenCalledWith(expect.anything(), { language: "en", flagLanguage: "en" })
      expect(outcome.headers?.["x-document-language"]).toBe("en")
    })

    it("mode 1 ⇒ tuỳ chọn writer y như trước ({ flagLanguage: vi }), header = ngôn ngữ file", async () => {
      asProject({ name: "Demo", mode: "import" })
      for (const language of ["vi", "en"] as const) {
        vi.mocked(writeDocx).mockClear()
        withTemplateLanguage(language)
        vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample })

        const outcome = await invoke(exportWord, OWNER, PROJECT, { source: "baseline" })
        expect(writeDocx).toHaveBeenCalledWith(expect.anything(), { flagLanguage: "vi" })
        expect(outcome.headers?.["x-document-language"]).toBe(language)
      }
    })

    it("§3.6: GET /document và export không gọi model (dự án vi còn thiếu bản dịch)", async () => {
      asProject(VI_PROJECT)
      vi.mocked(getDocumentWithMeta).mockResolvedValue({ doc: sample, translation })
      await invoke(getDocumentController, OWNER, PROJECT, { source: "draft" })
      await invoke(exportWord, OWNER, PROJECT, { source: "draft" })
      expect(executeAiAction).not.toHaveBeenCalled()
    })
  })
})
