/**
 * FLF-360 — job đọc lại ảnh sau 0.1 gặp xung đột khoá lạc quan: một CR ghi Spine đúng lúc job sắp ghi (job mang
 * `base_version` cũ). Một lần ⇒ job đọc lại Spine, dựng lại op, ghi được (dữ liệu CR vẫn còn). Lần nào cũng xung đột ⇒
 * dừng ảnh đó ở lượt này (`retry`), giữ cờ, không ghi gì.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/shared/ai/retry.service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/shared/ai/retry.service.js")>()),
  delay: async () => undefined,
  executeWithInRequestRetry: async <T>(fn: (attempt: number) => Promise<T>) => fn(0)
}))

/** Số lần một CR "chen" vào ngay trước lô ghi của job đọc lại. */
const race = vi.hoisted(() => ({ times: 0 }))
vi.mock("../../../src/modules/spine/op-engine.js", async (orig) => {
  const real = await orig<typeof import("../../../src/modules/spine/op-engine.js")>()
  return {
    ...real,
    applyTransaction: async (projectId: string, input: Parameters<typeof real.applyTransaction>[1]) => {
      if (race.times > 0 && input.reason?.startsWith("Import: đọc lại ảnh sơ đồ")) {
        race.times--
        await real.applyTransaction(projectId, { base_version: input.base_version, ops: [{ op: "set", path: "project.vision", value: `Changed by CR ${race.times}` }], by: "CR-001", reason: "CR-001", step_id: null })
      }
      return real.applyTransaction(projectId, input)
    }
  }
})

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { AiActionError } from "../../../src/shared/ai/ai-action.types.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { runImageReread } from "../../../src/modules/import/reread-jobs.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { buildPlaceholderPng } from "../../../src/modules/render/diagram-placeholder.js"
import { clearImportMediaCache } from "../../../src/modules/render/import-media.js"

const PNG = buildPlaceholderPng(12, 7, 0x40)

const finalizedWithUnreadImage = async () => {
  const ctx = await importAtExtracting({ srs: { images: [{ name: "image1.png", data: PNG, caption: "Figure 1 USECASE-IMG" }] } })
  mockOverrides.next = (prompt) => (prompt.includes("# Read Diagram Image") ? new AiActionError(503, "high demand", "GEMINI_OVERLOADED") : fakeMode1(prompt))
  await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  const base = (await spineRepository.get(ctx.projectId))!
  await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: base.spine_version })
  mockOverrides.next = fakeMode1
  return ctx
}

beforeEach(() => {
  resetMockLlm()
  clearImportMediaCache()
  race.times = 0
})

describe("FLF-360 job đọc lại ảnh - xung đột khoá lạc quan", () => {
  it("CR ghi trước một lần ⇒ đọc lại Spine, ghi được; dữ liệu của CR giữ nguyên", async () => {
    const { projectId, userId, importId } = await finalizedWithUnreadImage()
    race.times = 1
    expect(await runImageReread({ projectId, userId, importId })).toBe("done")
    const spine = (await spineRepository.get(projectId))!
    expect(spine.project.vision).toBe("Changed by CR 0")
    expect(spine.actors.some((a) => a.name === "Guest")).toBe(true)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread" && f.resolved_at === null)).toEqual([])
  })

  it("lần nào cũng xung đột ⇒ retry: không ghi dữ liệu ảnh, giữ cờ (lượt sau thử lại)", async () => {
    const { projectId, userId, importId } = await finalizedWithUnreadImage()
    race.times = 2
    expect(await runImageReread({ projectId, userId, importId })).toBe("retry")
    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.some((a) => a.name === "Guest")).toBe(false)
    expect(spine.flags.filter((f) => f.rule_id === "import_image_unread" && f.resolved_at === null)).toHaveLength(1)
  })
})
