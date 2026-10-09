import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * FLF-265 §3.1 / §3.6 — file version mode 1: tuỳ chọn writer đi qua `writerOptionsFor("import")` nhưng bytes y như
 * `{ flagLanguage: "vi" }` cũ; không gọi model. `renderSpineDocument` giả (đọc Mongo) — phần dựng thật có ở
 * test/integration/document-language-render.int.test.ts.
 */
vi.mock("../render/assemble.service.js", () => ({ renderSpineDocument: vi.fn() }))
vi.mock("../render/docx-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render/docx-writer.js")>()
  return { ...actual, writeDocx: vi.fn(actual.writeDocx) }
})
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))

import { renderVersionFile } from "./render-version.js"
import { renderSpineDocument } from "../render/assemble.service.js"
import { writeDocx } from "../render/docx-writer.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { readZipText } from "../render/zip.test-helper.js"
import type { RenderedDocument } from "../render/rendered-document.types.js"
import type { Spine } from "../spine/spine.types.js"

const sample = JSON.parse(readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")) as RenderedDocument
const PROJECT = "650000000000000000000001"

beforeEach(() => {
  vi.mocked(renderSpineDocument).mockReset()
  vi.mocked(renderSpineDocument).mockResolvedValue(sample)
  vi.mocked(writeDocx).mockClear()
  vi.mocked(executeAiAction).mockReset()
})

describe("renderVersionFile — mode 1 không đổi", () => {
  it("writer nhận đúng { flagLanguage: vi } như trước FLF-265", async () => {
    await renderVersionFile(PROJECT, "Demo", {} as Spine, { version: "1.0", stampSource: "release" })
    expect(renderSpineDocument).toHaveBeenCalledWith(PROJECT, "Demo", {}, { version: "1.0", source: "baseline", pendingRecord: undefined })
    expect(writeDocx).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeDocx).mock.calls[0][1]).toEqual({ flagLanguage: "vi" })
  })

  it("document.xml y hệt bản ghi với tuỳ chọn cũ; stamp vẫn có; không gọi model", async () => {
    const file = await renderVersionFile(PROJECT, "Demo", {} as Spine, { version: "1.0", stampSource: "release" })
    const old = await writeDocx(sample, { flagLanguage: "vi" })
    expect(readZipText(file, "word/document.xml")).toBe(readZipText(old, "word/document.xml"))
    expect(readZipText(file, "docProps/custom.xml")).toContain("release")
    expect(executeAiAction).not.toHaveBeenCalled()
  })
})
