/**
 * FLF-480 (ChoViet #14): "Trang khách hiện 'I. Record of Changes' tiếng Anh" — FE không có cách suy ngôn ngữ tài liệu
 * khi `Project.documentLanguage` chưa lưu (dự án import mode 1). `GET /projects/:id` phải trả thêm `document_language`
 * (field riêng, đã suy đúng theo `projectLanguages` — như `documentLanguageOf`) để FE dùng khi field tự lưu là null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, RequestHandler, Response } from "express"

vi.mock("../import/convert-from-fpt.service.js", () => ({ retryPendingConversion: vi.fn().mockResolvedValue(false) }))
vi.mock("../import/template-update.js", () => ({ templateUpdateOf: vi.fn().mockResolvedValue(null), templateCurrentOf: vi.fn().mockResolvedValue(null) }))
vi.mock("../translation/translation.service.js", () => ({ projectLanguages: vi.fn() }))
vi.mock("./project.service.js", () => ({ openProject: vi.fn(), getProjectById: vi.fn(), isDocumentLanguageLocked: vi.fn().mockResolvedValue(false) }))

import { getProject } from "./project.controller.js"
import { isDocumentLanguageLocked, openProject } from "./project.service.js"
import { projectLanguages } from "../translation/translation.service.js"

const PROJECT_ID = "650000000000000000000001"
const ORG_ID = "650000000000000000000099"

interface Outcome {
  status?: number
  body?: unknown
}

const invoke = (handler: RequestHandler, userId: string | undefined, projectId: string) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = {}
    const req = {
      orgContext: { orgId: ORG_ID, role: "analyst", membershipId: "650000000000000000000098" },
      user: userId ? { userId } : undefined,
      params: { projectId },
      query: {},
      body: {}
    } as unknown as Request
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
    void (handler as unknown as (req: Request, res: Response, next: () => void) => Promise<void>)(req, res, () => undefined)
  })

const project = (over: Record<string, unknown> = {}) => ({
  _id: PROJECT_ID,
  mode: "import",
  organizationId: ORG_ID,
  template_ref: null,
  ...over,
  toJSON() {
    return { _id: PROJECT_ID, mode: "import", organizationId: ORG_ID, ...over }
  }
})

describe("getProject - FLF-480 (ChoViet #14)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("dự án import mode 1 chưa lưu documentLanguage ⇒ document_language theo ngôn ngữ file (BE suy), không phải tiếng Anh cố định", async () => {
    vi.mocked(openProject).mockResolvedValue(project({ documentLanguage: undefined }) as never)
    vi.mocked(projectLanguages).mockResolvedValue({ locale: "vi", source: "vi" })

    const res = await invoke(getProject, "u1", PROJECT_ID)
    expect(res.status).toBe(200)
    expect((res.body as { data: { document_language: string } }).data.document_language).toBe("vi")
  })

  it("dự án đã lưu documentLanguage ⇒ document_language trùng field đã lưu", async () => {
    vi.mocked(openProject).mockResolvedValue(project({ documentLanguage: "en" }) as never)
    vi.mocked(projectLanguages).mockResolvedValue({ locale: "en", source: "en" })

    const res = await invoke(getProject, "u1", PROJECT_ID)
    expect((res.body as { data: { document_language: string } }).data.document_language).toBe("en")
  })

  it("FLF-456: trả document_language_locked theo BE để FE không mời đổi ngôn ngữ ở dự án có file nền", async () => {
    vi.mocked(openProject).mockResolvedValue(project({ mode: "fpt", documentLanguage: "en" }) as never)
    vi.mocked(projectLanguages).mockResolvedValue({ locale: "en", source: "en" })
    vi.mocked(isDocumentLanguageLocked).mockResolvedValueOnce(true)
    const res = await invoke(getProject, "u1", PROJECT_ID)
    expect((res.body as { data: { document_language_locked: boolean } }).data.document_language_locked).toBe(true)
  })
})
