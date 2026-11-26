/**
 * FLF-492: "AI viết gọn" mô tả dòng CR của Record of Changes — chọn dòng cần viết, kiểm câu trả về, lưu vào CR, không ném lỗi.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Spine } from "../spine/spine.types.js"

const state = vi.hoisted(() => ({
  changes: [] as Record<string, unknown>[],
  crs: new Map<string, { cr_id: string; record_summaries?: Record<string, unknown>[] }>(),
  ai: vi.fn()
}))

vi.mock("../render/assemble.service.js", () => ({
  listChangesForRecord: async () => state.changes,
  loadTemplateLayout: async () => ({ language: "vi" })
}))
vi.mock("../import/metered-ai.js", () => ({ withMeteredAi: (...args: unknown[]) => state.ai(...args) }))
vi.mock("../change-request/change-request.model.js", () => ({
  ChangeRequest: {
    find: (filter: { cr_id: { $in: string[] } }) => ({ lean: async () => filter.cr_id.$in.flatMap((id) => (state.crs.has(id) ? [state.crs.get(id)] : [])) }),
    findOne: (filter: { cr_id: string }) => ({ lean: async () => state.crs.get(filter.cr_id) ?? null }),
    updateOne: async (filter: { cr_id: string }, update: { $set: { record_summaries: Record<string, unknown>[] } }) => {
      const cr = state.crs.get(filter.cr_id)
      if (cr) cr.record_summaries = update.$set.record_summaries
    }
  }
}))

import { recordChangesHash } from "../render/cr-record.js"
import { cleanSummaryText, estimateRecordSummaryCredits, pendingSummaryUnits, summarizeRecordRows } from "./record-summary.service.js"

const spine = { use_cases: [{ id: "UC-09", name: "Nhắc lịch" }], screens: [{ id: "S01", name: "Trang chủ" }] } as unknown as Spine

const row = (txn: string, by: string, op: string, path: string) => ({ txn, at: "2026-11-25T03:00:00.000Z", by, reason: `${by}: x`, op, path, step_id: null })

beforeEach(() => {
  state.ai.mockReset()
  state.crs = new Map([
    ["CR-001", { cr_id: "CR-001" }],
    ["CR-002", { cr_id: "CR-002" }]
  ])
  state.changes = [
    row("t1", "CR-001", "add", "use_cases[id=UC-09]"),
    row("t1", "CR-001", "set", "screens[id=S01].name"),
    row("t2", "CR-002", "set", "project.vision")
  ]
})

describe("cleanSummaryText", () => {
  it("bỏ tiền tố mã CR, đổi em dash, từ chối câu rỗng / quá dài / sai ngôn ngữ", () => {
    expect(cleanSummaryText("CR-001: Thêm use case Nhắc lịch — kèm màn hình", "CR-001", "vi")).toBe("Thêm use case Nhắc lịch - kèm màn hình")
    expect(cleanSummaryText("   ", "CR-001", "vi")).toBeNull()
    expect(cleanSummaryText("x".repeat(201), "CR-001", "en")).toBeNull()
    expect(cleanSummaryText("Thêm use case Nhắc lịch", "CR-001", "en")).toBeNull()
    expect(cleanSummaryText("Add the reminder use case", "CR-001", "vi")).toBeNull()
  })
})

describe("pendingSummaryUnits", () => {
  it("một đơn vị mỗi (CR, loại A / M / D); CR ngoài gói bị bỏ; dòng đã có mô tả đúng ngôn ngữ và dấu vân tay thì bỏ", async () => {
    const all = await pendingSummaryUnits("p1", spine, ["CR-001", "CR-002"], "vi")
    expect(all.map((u) => [u.cr_id, u.kind])).toEqual([["CR-001", "A"], ["CR-001", "M"], ["CR-002", "M"]])
    expect((await pendingSummaryUnits("p1", spine, ["CR-002"], "vi")).map((u) => u.cr_id)).toEqual(["CR-002"])

    const unit = all[0]
    state.crs.get("CR-001")!.record_summaries = [{ kind: "A", text: "x", language: "vi", changes_hash: recordChangesHash(unit.changes) }]
    expect((await pendingSummaryUnits("p1", spine, ["CR-001"], "vi")).map((u) => u.kind)).toEqual(["M"])
    // Khác ngôn ngữ ⇒ vẫn cần viết
    expect((await pendingSummaryUnits("p1", spine, ["CR-001"], "en")).map((u) => u.kind)).toEqual(["A", "M"])
  })

  it("ước tính credit: một lượt cho tối đa 20 dòng; không có dòng ⇒ 0", async () => {
    expect(await estimateRecordSummaryCredits("p1", spine, ["CR-001", "CR-002"], "vi")).toBe(1)
    expect(await estimateRecordSummaryCredits("p1", spine, [], "vi")).toBe(0)
  })
})

describe("summarizeRecordRows", () => {
  it("lưu câu hợp lệ vào CR, bỏ câu sai ngôn ngữ; dòng không được viết giữ câu dựng sẵn", async () => {
    state.ai.mockResolvedValue({
      ok: true,
      data: {
        rows: [
          { cr_id: "CR-001", kind: "A", text: "CR-001: Thêm use case Nhắc lịch" },
          { cr_id: "CR-001", kind: "M", text: "Update the home screen" },
          { cr_id: "CR-002", kind: "M", text: "Cập nhật tầm nhìn sản phẩm" }
        ]
      }
    })
    const res = await summarizeRecordRows("p1", "u1", spine, ["CR-001", "CR-002"], "vi", "release:1.0")
    expect(res).toEqual({ requested: 3, saved: 2 })
    expect(state.crs.get("CR-001")!.record_summaries).toEqual([expect.objectContaining({ kind: "A", text: "Thêm use case Nhắc lịch", language: "vi" })])
    expect(state.crs.get("CR-002")!.record_summaries).toEqual([expect.objectContaining({ kind: "M", text: "Cập nhật tầm nhìn sản phẩm" })])
    // Prompt: ngôn ngữ + khối Rows có câu dựng sẵn
    const vars = state.ai.mock.calls[0][2] as { language: string; rows: string }
    expect(vars.language).toBe("Vietnamese")
    expect(JSON.parse(vars.rows)[0]).toMatchObject({ cr_id: "CR-001", kind: "A", built: expect.stringContaining("use case") })
  })

  it("AI lỗi / hết credit ⇒ không ném lỗi, CR không đổi", async () => {
    state.ai.mockResolvedValue({ ok: false, reason: "credits", message: "no credit", userMessage: "", usageId: "x", kind: "credits" })
    expect(await summarizeRecordRows("p1", "u1", spine, ["CR-001"], "vi", "release:1.0")).toEqual({ requested: 2, saved: 0 })
    expect(state.crs.get("CR-001")!.record_summaries).toBeUndefined()
    state.ai.mockRejectedValue(new Error("boom"))
    await expect(summarizeRecordRows("p1", "u1", spine, ["CR-001"], "vi", "release:1.0")).resolves.toEqual({ requested: 2, saved: 0 })
  })

  it("gói không có dòng CR nào ⇒ không gọi AI", async () => {
    expect(await summarizeRecordRows("p1", "u1", spine, [], "vi", "release:1.0")).toEqual({ requested: 0, saved: 0 })
    expect(state.ai).not.toHaveBeenCalled()
  })
})
