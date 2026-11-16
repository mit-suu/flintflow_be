import { readFileSync } from "node:fs"
import type { Request, Response } from "express"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  sourceFidelityFor: vi.fn(),
  writeProjectDocx: vi.fn()
}))

vi.mock("./render.controller.js", () => ({ authorize: mocks.authorize }))
vi.mock("./source-fidelity.js", () => ({ sourceFidelityFor: mocks.sourceFidelityFor }))
vi.mock("./project-docx-writer.js", () => ({ writeProjectDocx: mocks.writeProjectDocx, loadFixedTemplateContext: vi.fn() }))
vi.mock("./assemble.service.js", () => ({
  getDocumentWithMeta: vi.fn(async () => ({ doc: JSON.parse(readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")) })),
  getDraftMeta: vi.fn(async () => null),
  renderSpineDocument: vi.fn(),
  NoWorkingDraftError: class extends Error {}
}))
vi.mock("../doc-version/template-source-binding.js", () => ({ resolveFixedBaselineVersion: vi.fn() }))
vi.mock("../translation/translation.service.js", () => ({ assertTranslationComplete: vi.fn(), documentLanguageUnavailable: vi.fn() }))
vi.mock("../../shared/pdf/gotenberg.client.js", () => ({ docxToPdf: vi.fn(), PdfConverterError: class extends Error {} }))
vi.mock("../../shared/auth/viewer-read-scope.middleware.js", () => ({ isViewer: () => false }))

const { exportWord } = await import("./export.controller.js")

const run = () =>
  new Promise<void>((resolve, reject) => {
    const req = { user: { userId: "u" }, params: { projectId: "p" }, query: { source: "draft" } } as unknown as Request
    const res = { status: () => res, setHeader: () => res, send: () => { resolve(); return res } } as unknown as Response
    exportWord(req, res, (err?: unknown) => (err ? reject(err) : resolve()))
  })

describe("export Word dùng sourceFidelityFor cho mọi dự án", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeProjectDocx.mockResolvedValue(Buffer.from("docx"))
  })

  it("dự án mode fpt, mẫu tự do (đã đổi mẫu ⇒ có file nền mới): vẫn gọi sourceFidelityFor và truyền fidelity cho writer", async () => {
    mocks.authorize.mockResolvedValue({ projectId: "p", projectName: "Demo", mode: "fpt", documentLanguage: "en", sourceLanguage: "en", convertedFrom: null, templateIntent: "free" })
    const fidelity = { keepSource: new Set(["fixed:1"]) }
    mocks.sourceFidelityFor.mockResolvedValue(fidelity)
    await run()
    expect(mocks.sourceFidelityFor).toHaveBeenCalledTimes(1)
    expect(mocks.writeProjectDocx.mock.calls[0][4]).toBe(fidelity)
  })

  it("dự án chưa có file nền: sourceFidelityFor trả undefined ⇒ writer nhận undefined (đường cũ)", async () => {
    mocks.authorize.mockResolvedValue({ projectId: "p", projectName: "Demo", mode: "fpt", documentLanguage: "en", sourceLanguage: "en", convertedFrom: null, templateIntent: "free" })
    mocks.sourceFidelityFor.mockResolvedValue(undefined)
    await run()
    expect(mocks.writeProjectDocx.mock.calls[0][4]).toBeUndefined()
  })
})
