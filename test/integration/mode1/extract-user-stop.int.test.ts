/**
 * Người dùng dừng lượt đọc nội dung (`POST /import/pause` → `requestStop`): I-4 dừng trước lượt AI kế tiếp, không gọi / trừ
 * thêm; tiếp tục chạy từ đúng lượt đó, kết quả như chạy một mạch. Mongo thật + provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { AI_BLOCK_CHARS, runExtraction } from "../../../src/modules/import/extract.service.js"
import { requestStop } from "../../../src/modules/import/extract-jobs.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

/** 10 đoạn ~5,9k ký tự ở mục 1 ⇒ 3 lô chữ: [P01–P04], [P05–P08], [P09–P10]. */
const LONG = {
  srs: {
    overviewParagraphs: Array.from({ length: 10 }, (_, i) => `MARK-P${String(i + 1).padStart(2, "0")} ` + "Lumen keeps course material organised for small centres. ".repeat(Math.floor((AI_BLOCK_CHARS - 200) / 58)))
  }
}

let marks: string[] = []
let onOverview: (() => void) | null = null

beforeEach(() => {
  resetMockLlm()
  marks = []
  onOverview = null
  mockOverrides.next = (prompt) => {
    if (prompt.includes("# Import Extract") && prompt.includes("Section (registry id): fixed:1")) {
      marks.push(/MARK-P(\d\d)/.exec(prompt)?.[1] ?? "?")
      onOverview?.()
    }
    return fakeMode1(prompt)
  }
})

const deducted = (projectId: string) => Usage.countDocuments({ projectId, step_id: "I-4:fixed:1", state: "deducted" })

describe("I-4 - người dùng dừng / tiếp tục", () => {
  it("bấm Dừng trong lô 1 ⇒ không gọi lô 2; tiếp tục chạy từ lô 2, không gọi lại lô 1", async () => {
    const ctx = await importAtExtracting(LONG)
    // Người dùng bấm Dừng trong lúc lô 1 đang gọi AI (request khác ghi thẳng cờ, như `requestStop`)
    let pending: Promise<unknown> | null = null
    onOverview = () => {
      onOverview = null
      pending = ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: { reason: "user", at: new Date() } } }).exec()
    }
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    await pending
    expect(first.doc.status).toBe("extracting")
    expect(first.doc.paused?.reason).toBe("user")
    expect(marks).toEqual(["01"])
    expect(await deducted(ctx.projectId)).toBe(1)
    const draft = (await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: "fixed:1" }).lean())!
    expect(draft).toMatchObject({ status: "pending", partial: { steps_done: 1 } })

    // Tiếp tục (`/import/resume` bỏ `paused` rồi chạy lại job)
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { paused: null } })
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(resumed.doc.status).toBe("baselining")
    expect(marks).toEqual(["01", "05", "09"])
    expect(await deducted(ctx.projectId)).toBe(3)
  })

  it("requestStop: chưa bấm Bắt đầu ⇒ IMPORT_INVALID_STATE; đã dừng ⇒ trả nguyên trạng", async () => {
    const ctx = await importAtExtracting()
    await expect(requestStop(ctx.projectId, ctx.importId)).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })

    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { extract_cursor: "fixed:1" } })
    const stopped = await requestStop(ctx.projectId, ctx.importId)
    expect(stopped.paused?.reason).toBe("user")
    const again = await requestStop(ctx.projectId, ctx.importId)
    expect(again.paused?.reason).toBe("user")
    expect(again.paused?.at.getTime()).toBe(stopped.paused?.at.getTime())
  })
})
