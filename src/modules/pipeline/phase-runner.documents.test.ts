import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ai/document-context.service.js")>()
  return {
    ...actual,
    buildDocumentContext: vi.fn(async () => ({ contextText: "DOC", tokenCount: 1, documentsUsed: 1, usedSummary: false, mode: "retrieved", chunksUsed: 1, fullTokens: 9 }))
  }
})

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { unitDocuments } from "./phase-runner.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

beforeEach(() => vi.mocked(buildDocumentContext).mockClear())

describe("unitDocuments — lượt phỏng vấn đầu giai đoạn (FLF-393)", () => {
  it("tin user vừa gõ đứng đầu câu hỏi tìm đoạn (demo 2026-11-12: thiếu nó ⇒ chỉ thấy bìa + mục lục)", async () => {
    expect(await unitDocuments("p", FIXTURE, "B-0", "UC-05 là gì và BR-02 nói gì?")).toBe("DOC")
    const request = vi.mocked(buildDocumentContext).mock.calls[0]![0]
    expect(request).toMatchObject({ projectId: "p", actionType: "draft", stepId: "B-0.1" })
    expect(request.query?.split("\n")[0]).toBe("UC-05 là gì và BR-02 nói gì?")
    expect(request.query).toContain("Brain Dump")
  })

  it("không có tin user (lượt hỏi tự động) ⇒ câu hỏi chỉ từ nhãn / section của các bước", async () => {
    await unitDocuments("p", FIXTURE, "S-3")
    const request = vi.mocked(buildDocumentContext).mock.calls[0]![0]
    expect(request.query).toContain("Actors")
    expect(request.sectionTitles).toEqual(expect.arrayContaining(["Actors", "Tác nhân"]))
  })

  it("giai đoạn không bước nào đọc tài liệu ⇒ rỗng, không gọi", async () => {
    expect(await unitDocuments("p", FIXTURE, "S-9", "bất kỳ")).toBe("")
    expect(buildDocumentContext).not.toHaveBeenCalled()
  })
})
