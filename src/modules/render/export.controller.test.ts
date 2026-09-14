import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { NextFunction, Request, Response } from "express"

vi.mock("../../shared/auth/auth.middleware.js", () => ({ authMiddleware: vi.fn() }))

import { DOCX_MIME, previewWord } from "./export.controller.js"
import exportRoutes from "./export.route.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { readZipText } from "./zip.test-helper.js"

const sample = JSON.parse(
  readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")
) as Record<string, unknown>

interface Outcome {
  status?: number
  headers: Record<string, string>
  body?: Buffer
  error?: unknown
}

const invoke = (userId: string | undefined, body: unknown) =>
  new Promise<Outcome>((resolve) => {
    const outcome: Outcome = { headers: {} }
    const req = { user: userId ? { userId } : undefined, body } as unknown as Request
    const res = {
      status(code: number) {
        outcome.status = code
        return this
      },
      setHeader(name: string, value: string) {
        outcome.headers[name.toLowerCase()] = value
        return this
      },
      send(payload: Buffer) {
        outcome.body = payload
        resolve(outcome)
        return this
      }
    } as unknown as Response
    const next: NextFunction = (err?: unknown) => {
      outcome.error = err
      resolve(outcome)
    }
    previewWord(req, res, next)
  })

describe("POST /export/word/preview", () => {
  it("200 trả file docx, MIME và tên file đúng định dạng", async () => {
    const outcome = await invoke("650000000000000000000010", sample)

    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(200)
    expect(outcome.headers["content-type"]).toBe(DOCX_MIME)
    expect(outcome.headers["content-disposition"]).toBe('attachment; filename="lumen-hoc-truc-tuyen-v0.3-draft.docx"')
    expect(outcome.headers["content-length"]).toBe(String(outcome.body?.length))

    const documentXml = readZipText(outcome.body as Buffer, "word/document.xml")
    expect(documentXml).toContain("DRAFT")
  })

  it("422 RENDERED_DOCUMENT_INVALID khi body sai hợp đồng", async () => {
    const outcome = await invoke("650000000000000000000010", { ...sample, sections: "nope" })

    expect(outcome.status).toBeUndefined()
    expect(outcome.error).toMatchObject({ statusCode: 422, code: "RENDERED_DOCUMENT_INVALID" })
    expect((outcome.error as Error).message).toContain("sections")
  })

  it("401 khi thiếu user", async () => {
    const outcome = await invoke(undefined, sample)
    expect(outcome.error).toMatchObject({ statusCode: 401 })
  })

  it("route được đăng ký POST kèm authMiddleware", () => {
    const layer = exportRoutes.stack.find((l) => l.route?.path === "/word/preview")
    expect(layer, "thiếu route /word/preview").toBeDefined()

    const route = layer?.route as unknown as { methods: Record<string, boolean>; stack: { handle: unknown }[] }
    expect(route.methods.post).toBe(true)
    expect(route.stack[0].handle).toBe(authMiddleware)
  })
})
