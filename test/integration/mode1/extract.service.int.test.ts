/**
 * I-4 trích field (nút 1.8) ở tầng service trên Mongo thật + provider AI giả — plan §8.2 `extract.service.test.ts`.
 * FLF-172 P4. Gọi `runExtraction` trực tiếp (không qua job nền) để kiểm từng lượt gọi AI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, useExtractConcurrency } from "../../helpers/mode1-import-p4.js"
import { patchFields, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

// Khẳng định thứ tự lượt gọi / số dư ví của bản tuần tự (FLF-392: song song ở extract-parallel.int.test.ts)
useExtractConcurrency(1)

/** Section trong prompt I-4 của mỗi lượt gọi provider (kể cả lượt retry). */
let calls: string[] = []
const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
const record = (fn: (prompt: string) => string | Error | undefined) => (prompt: string) => {
  if (prompt.includes("# Import Extract")) calls.push(sectionOf(prompt))
  return fn(prompt)
}

beforeEach(() => {
  resetMockLlm()
  calls = []
  mockOverrides.next = record(fakeMode1)
})

const TABLE_SECTIONS = ["fixed:2.1", "fixed:2.2.2", "fixed:5.1"]
/** Thứ tự section có chữ (gọi AI) của SRS mẫu. */
const AI_ORDER = ["fixed:1", "fixed:2.2.1", "fixed:3.1.2"]

const wallet = async (userId: string) => CreditWallet.findOne({ userId }).lean()
const draftsOf = async (importId: string) => ExtractionDraft.find({ import_id: importId }).lean()

describe("I-4 - bảng khớp đủ cột", () => {
  it("bảng actor/UC/BR trích tất định, không gọi AI, không usage, không trừ credit", async () => {
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    // FLF-462: 2 field độ tin thấp của mục đọc theo nội dung ("function:@B…") ⇒ dừng ở bước 1.6 chờ xác nhận
    expect(run.doc.status).toBe("fields_review")

    for (const s of TABLE_SECTIONS) expect(calls, s).not.toContain(s)
    // FLF-444: + mục riêng "5.9 Team Notes" (heading tự đặt cũng đọc theo nội dung)
    expect(calls).toHaveLength(7)
    const drafts = await draftsOf(ctx.importId)
    for (const s of TABLE_SECTIONS) {
      const d = drafts.find((x) => x.section_id === s)!
      expect(d, s).toMatchObject({ status: "done", usage_id: null })
      expect(d.fields.length, s).toBeGreaterThan(0)
      expect(d.fields.every((f) => f.origin === "deterministic"), s).toBe(true)
    }
    const uc = drafts.find((x) => x.section_id === "fixed:2.2.2")!
    expect(uc.fields.map((f) => [f.path, f.value])).toEqual(
      expect.arrayContaining([
        ["use_cases[id=UC-01].name", "Register account"],
        ["use_cases[id=UC-02].actor_ids", ["Learner"]]
      ])
    )
    expect(await Usage.countDocuments({ projectId: ctx.projectId, step_id: { $in: TABLE_SECTIONS.map((s) => `I-4:${s}`) } })).toBe(0)
    // 7 lượt mẫu ngắn × 1 credit (quyết toán theo token)
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 993, reserved: 0 })
  })
})

describe("I-4 - output sai schema", () => {
  it("sai schema 2 lần rồi đúng ⇒ retry trong cùng lượt (3 lần gọi), trừ credit một lần", async () => {
    let bad = 0
    mockOverrides.next = record((prompt) => {
      if (prompt.includes("# Import Extract") && sectionOf(prompt) === "fixed:1" && bad < 2) {
        bad++
        return bad === 1 ? "not json at all" : JSON.stringify({ section_id: "fixed:1", items: [{ entity: "flags", key: null, value: {}, confidence: 2, source_block_ids: [] }] })
      }
      return fakeMode1(prompt)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.paused).toBeNull()
    expect(calls.filter((s) => s === "fixed:1")).toHaveLength(3)
    expect(calls).toHaveLength(9)
    expect(await Usage.find({ projectId: ctx.projectId, step_id: "I-4:fixed:1" }).distinct("state")).toEqual(["deducted"])
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 993, reserved: 0 })
    const d = (await draftsOf(ctx.importId)).find((x) => x.section_id === "fixed:1")!
    expect(d.status).toBe("done")
  }, 20_000)

  it("sai schema cả 3 lần (retry ≤ 2) ⇒ dừng resume_later, section failed, hoàn credit", async () => {
    mockOverrides.next = record((prompt) => (prompt.includes("# Import Extract") ? '{"section_id":"fixed:1","items":"nope"}' : fakeMode1(prompt)))
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls).toEqual(["fixed:1", "fixed:1", "fixed:1"])
    expect(run.doc.status).toBe("extracting")
    expect(run.doc.paused?.reason).toBe("resume_later")
    expect(run.doc.extract_cursor).toBe("fixed:1")
    expect(run.sections.find((s) => s.section_id === "fixed:1")).toMatchObject({ status: "failed" })
    expect(run.sections.find((s) => s.section_id === "fixed:1")?.error).toBeTruthy()
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 1000, reserved: 0 })
    expect(await Usage.find({ projectId: ctx.projectId, step_id: "I-4:fixed:1" }).distinct("state")).toEqual(["refunded"])
  }, 20_000)
})

describe("I-4 - độ tin", () => {
  it("FLF-462 (đảo FLF-343): field độ tin < 0.7 ⇒ dừng ở fields_review (bước 1.6), chỉ field đó đếm là cần xem", async () => {
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("fields_review")
    const needing = run.sections.filter((s) => s.fields_needing_review > 0)
    expect(needing.map((s) => s.fields_needing_review)).toEqual([1, 1])
    expect(needing.every((s) => s.section_id.startsWith("function:@B"))).toBe(true)
  })

  it("mọi field ≥ 0.7 ⇒ bỏ qua bước xác nhận, sang baselining", async () => {
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || !prompt.includes("# Import Extract")) return out
      const json = JSON.parse(out) as { items: { field_confidence: Record<string, number> }[] }
      for (const i of json.items) i.field_confidence = {}
      return JSON.stringify(json)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("baselining")
  })

  it("độ tin AI cả item thấp (0.3) ⇒ dù tín hiệu code khớp (FLF-343: 0.3 × 0.6 + 1 × 0.4 < 0.7) mọi field của item cần xem", async () => {
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || sectionOf(prompt) !== "fixed:3.1.2") return out
      const json = JSON.parse(out) as { items: { confidence: number }[] }
      for (const i of json.items) i.confidence = 0.3
      return JSON.stringify(json)
    })
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    const s = run.sections.find((x) => x.section_id === "fixed:3.1.2")!
    expect(s.fields_needing_review).toBe(s.fields_total)
    expect(s.fields_total).toBe(2)
  })
})

describe("I-4 - hết credit, resume", () => {
  it("hết credit ⇒ paused credits, giữ cursor ở section đang dở; nạp rồi resume không trích lại section done", async () => {
    // 3 credit: đủ 2 lượt ngắn (1 credit / lượt), lượt thứ 3 (fixed:3.1.2) thiếu khi giữ 2 credit
    const ctx = await importAtExtracting({ balance: 3 })
    const first = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(first.doc.status).toBe("extracting")
    expect(first.doc.paused?.reason).toBe("credits")
    expect(first.doc.extract_cursor).toBe(AI_ORDER[2])
    expect(calls).toEqual(AI_ORDER.slice(0, 2))
    const done = first.sections.filter((s) => s.status === "done").map((s) => s.section_id)
    expect(done).toEqual(expect.arrayContaining([...AI_ORDER.slice(0, 2), "fixed:2.1", "fixed:2.2.2"]))
    // section đang dở vì credit vẫn `pending` (không `failed`), lượt reserve bị huỷ, ví không giữ tiền treo
    expect(first.sections.find((s) => s.section_id === AI_ORDER[2])?.status).toBe("pending")
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 1, reserved: 0 })
    const persisted = await ImportedDocument.findById(ctx.importId).lean()
    expect(persisted).toMatchObject({ extract_cursor: AI_ORDER[2], paused: { reason: "credits" } })

    const snapshot = new Map((await draftsOf(ctx.importId)).filter((d) => d.status === "done").map((d) => [d.section_id, JSON.stringify(d.fields)]))
    await CreditWallet.updateOne({ userId: ctx.userId }, { $set: { balance: 1000 } })
    calls = []
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(resumed.doc.paused).toBeNull()
    expect(resumed.doc.extract_cursor).toBeNull()
    // FLF-462: cùng 2 field độ tin thấp của mục đọc theo nội dung ⇒ dừng ở bước 1.6
    expect(resumed.doc.status).toBe("fields_review")
    for (const s of done) expect(calls, s).not.toContain(s)
    expect(calls[0]).toBe(AI_ORDER[2])
    expect(calls).toHaveLength(5)
    // field của section đã xong không bị ghi lại
    const after = await draftsOf(ctx.importId)
    for (const [s, fields] of snapshot) expect(JSON.stringify(after.find((d) => d.section_id === s)!.fields), s).toBe(fields)
  })

  it("resume khi mọi section đã xong ⇒ không gọi AI lần nào", async () => {
    const ctx = await importAtExtracting()
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    // đưa về extracting (như job bị mất sau khi xong hết section)
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { status: "extracting" } })
    calls = []
    const again = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls).toEqual([])
    // FLF-462: cùng 2 field độ tin thấp của mục đọc theo nội dung ⇒ dừng ở bước 1.6
    expect(again.doc.status).toBe("fields_review")
  })
})

describe("I-4 - lỗi AI", () => {
  it("provider lỗi giữa chừng ⇒ release hold: ví hoàn phần giữ, usage refunded; resume trích lại section failed", async () => {
    mockOverrides.next = record((prompt) => (prompt.includes("# Import Extract") && sectionOf(prompt) === AI_ORDER[2] ? new Error("provider down") : fakeMode1(prompt)))
    const ctx = await importAtExtracting()
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.paused?.reason).toBe("resume_later")
    expect(run.doc.extract_cursor).toBe(AI_ORDER[2])
    expect(run.sections.find((s) => s.section_id === AI_ORDER[2])).toMatchObject({ status: "failed", error: expect.stringContaining("Dịch vụ AI đang gặp sự cố") })
    // 2 lượt thành công đã trừ (1 credit / lượt), lượt lỗi được hoàn: không còn credit treo
    expect(await wallet(ctx.userId)).toMatchObject({ balance: 998, reserved: 0 })
    expect(await Usage.find({ projectId: ctx.projectId, step_id: `I-4:${AI_ORDER[2]}` }).distinct("state")).toEqual(["refunded"])
    expect(await Usage.countDocuments({ projectId: ctx.projectId, state: "reserved" })).toBe(0)

    mockOverrides.next = record(fakeMode1)
    calls = []
    const resumed = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(calls[0]).toBe(AI_ORDER[2])
    expect(resumed.sections.every((s) => s.status === "done")).toBe(true)
    // FLF-462: cùng 2 field độ tin thấp của mục đọc theo nội dung ⇒ dừng ở bước 1.6
    expect(resumed.doc.status).toBe("fields_review")
  })

  it("import không ở extracting ⇒ IMPORT_INVALID_STATE, không gọi AI", async () => {
    const ctx = await importAtExtracting()
    await ImportedDocument.updateOne({ _id: ctx.importId }, { $set: { status: "fields_review" } })
    await expect(runExtraction(ctx.projectId, ctx.userId, ctx.importId)).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
    expect(calls).toEqual([])
  })
})

describe("FLF-462 - bước 1.6: đoạn lớp 4 chữ hướng dẫn (AI phân loại ở I-4) dừng xác nhận; xác nhận là hướng dẫn nâng lớp chắc chắn", () => {
  it("đoạn lớp 4 độ tin thấp ⇒ dừng ở fields_review, hiện trong review_guidance; xác nhận là hướng dẫn ⇒ DocBlock lên lớp 3, confirm_all hết việc còn lại ⇒ baselining", async () => {
    const ctx = await importAtExtracting()
    const nfrBlock = await DocBlock.findOne({ projectId: ctx.projectId, section_id: "fixed:4.2.3", kind: "paragraph" }).lean()
    expect(nfrBlock, "cần một block ở fixed:4.2.3 để gắn lớp 4 giả").toBeTruthy()
    await DocBlock.updateOne({ _id: nfrBlock!._id }, { $set: { guidance_layer: 4 } })

    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || sectionOf(prompt) !== "fixed:4.2.3") return out
      const json = JSON.parse(out) as { guidance_blocks?: unknown[] }
      json.guidance_blocks = [{ block_id: nfrBlock!.block_id, is_guidance: true, confidence: 0.4 }]
      return JSON.stringify(json)
    })

    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("fields_review")

    const { extractionSummary } = await import("../../../src/modules/import/import.service.js")
    const summary = await extractionSummary(run.doc._id as unknown as string)
    expect(summary.review_guidance).toEqual([
      expect.objectContaining({ section_id: "fixed:4.2.3", block_id: nfrBlock!.block_id, is_guidance: true, confidence: 0.4, confirmed: false })
    ])

    // Trước xác nhận: AI vẫn trích NFR từ đoạn lớp 4 (prompt luật 10) ⇒ mục 4.2.3 còn field nguồn từ đoạn đó
    const nfrFields = async () => ((await draftsOf(ctx.importId)).find((d) => d.section_id === "fixed:4.2.3")?.fields ?? []).filter((f) => f.source_block_ids.includes(nfrBlock!.block_id))
    expect((await nfrFields()).length).toBeGreaterThan(0)
    const otherBefore = (await draftsOf(ctx.importId)).filter((d) => d.section_id !== "fixed:4.2.3").map((d) => d.fields.length)

    // Xác nhận riêng đoạn lớp 4 là hướng dẫn: còn 2 field độ tin thấp khác (function:@B…) ⇒ vẫn ở fields_review
    const afterGuidance = await patchFields(ctx.projectId, {
      import_id: ctx.importId,
      fields: [],
      guidance: [{ section_id: "fixed:4.2.3", block_id: nfrBlock!.block_id, is_guidance: true }],
      content_mismatch: [],
      confirm_all: false
    })
    expect(afterGuidance.status).toBe("fields_review")
    // FLF-462: đoạn được xác nhận là hướng dẫn ⇒ Code nâng `guidance_layer` lên 3 (chắc chắn) ngay trên DocBlock đã lưu,
    // để I-5 (templateMarks / stripTemplateMarks) không còn tính đoạn này là nội dung thật
    expect((await DocBlock.findOne({ _id: nfrBlock!._id }).lean())?.guidance_layer).toBe(3)
    // Tiêu chí Jira FLF-462: người xác nhận là hướng dẫn ⇒ mục thành "thiếu" ở I-5: không còn field nào chỉ có nguồn từ đoạn đó
    // (Spine không nhận dữ liệu 4.2.3), field của mục khác giữ nguyên
    expect(await nfrFields()).toEqual([])
    expect((await draftsOf(ctx.importId)).filter((d) => d.section_id !== "fixed:4.2.3").map((d) => d.fields.length)).toEqual(otherBefore)

    // Xác nhận hết phần còn lại theo gợi ý AI ⇒ hết việc cần xác nhận ⇒ baselining
    const done = await patchFields(ctx.projectId, { import_id: ctx.importId, fields: [], guidance: [], content_mismatch: [], confirm_all: true })
    expect(done.status).toBe("baselining")
  })

  it("xác nhận là nội dung thật ⇒ không đổi guidance_layer của DocBlock", async () => {
    const ctx = await importAtExtracting()
    const nfrBlock = await DocBlock.findOne({ projectId: ctx.projectId, section_id: "fixed:4.2.3", kind: "paragraph" }).lean()
    await DocBlock.updateOne({ _id: nfrBlock!._id }, { $set: { guidance_layer: 4 } })
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || sectionOf(prompt) !== "fixed:4.2.3") return out
      const json = JSON.parse(out) as { guidance_blocks?: unknown[] }
      json.guidance_blocks = [{ block_id: nfrBlock!.block_id, is_guidance: true, confidence: 0.4 }]
      return JSON.stringify(json)
    })
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    await patchFields(ctx.projectId, {
      import_id: ctx.importId,
      fields: [],
      guidance: [{ section_id: "fixed:4.2.3", block_id: nfrBlock!.block_id, is_guidance: false }],
      content_mismatch: [],
      confirm_all: false
    })
    expect((await DocBlock.findOne({ _id: nfrBlock!._id }).lean())?.guidance_layer).toBe(4)
    // Là nội dung thật ⇒ field vẫn giữ (mục vẫn "có")
    const fields = (await draftsOf(ctx.importId)).find((d) => d.section_id === "fixed:4.2.3")!.fields
    expect(fields.some((f) => f.source_block_ids.includes(nfrBlock!.block_id))).toBe(true)
  })

  /** Đoạn lớp 4 AI chấm `is_guidance: true` độ tin cao 0.9: không tự thành hướng dẫn chắc chắn (BF §3.1.1: điểm AI không là tín hiệu duy nhất). */
  const highConfidenceGuidance = async (clearLowConfidence: boolean) => {
    const ctx = await importAtExtracting()
    const nfrBlock = await DocBlock.findOne({ projectId: ctx.projectId, section_id: "fixed:4.2.3", kind: "paragraph" }).lean()
    await DocBlock.updateOne({ _id: nfrBlock!._id }, { $set: { guidance_layer: 4 } })
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || !prompt.includes("# Import Extract")) return out
      const json = JSON.parse(out) as { items: { field_confidence: Record<string, number> }[]; guidance_blocks?: unknown[] }
      if (clearLowConfidence) for (const i of json.items) i.field_confidence = {}
      if (sectionOf(prompt) === "fixed:4.2.3") json.guidance_blocks = [{ block_id: nfrBlock!.block_id, is_guidance: true, confidence: 0.9 }]
      return JSON.stringify(json)
    })
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    return { ctx, nfrBlock: nfrBlock!, run }
  }
  const layerOf = async (id: import("mongoose").Types.ObjectId) => (await DocBlock.findOne({ _id: id }).lean())?.guidance_layer
  const nfrFieldCount = async (importId: string, blockId: string) =>
    ((await draftsOf(importId)).find((d) => d.section_id === "fixed:4.2.3")?.fields ?? []).filter((f) => f.source_block_ids.includes(blockId)).length

  it("lớp 4 AI độ tin cao, không có gì khác để xác nhận ⇒ baselining, giữ lớp 4 và field (nội dung thật)", async () => {
    const { ctx, nfrBlock, run } = await highConfidenceGuidance(true)
    expect(run.doc.status).toBe("baselining")
    expect(await layerOf(nfrBlock._id)).toBe(4)
    expect(await nfrFieldCount(ctx.importId, nfrBlock.block_id)).toBeGreaterThan(0)
  })

  it("lớp 4 AI độ tin cao, có việc khác dừng ở 1.6 rồi Xác nhận tất cả ⇒ cùng kết quả: giữ lớp 4 và field", async () => {
    const { ctx, nfrBlock, run } = await highConfidenceGuidance(false)
    expect(run.doc.status).toBe("fields_review")
    const done = await patchFields(ctx.projectId, { import_id: ctx.importId, fields: [], guidance: [], content_mismatch: [], confirm_all: true })
    expect(done.status).toBe("baselining")
    expect(await layerOf(nfrBlock._id)).toBe(4)
    expect(await nfrFieldCount(ctx.importId, nfrBlock.block_id)).toBeGreaterThan(0)
  })
})

describe("FLF-462 - bước 1.6: ô bảng lớp 4 (đúng 1 dấu hiệu) vào guidance_candidates của lượt I-4, AI phân loại, người xác nhận", () => {
  /** Thêm bảng 1 ô vào mục 4.2.3 (bảng không khớp cột nào ⇒ AI đọc), ô gắn lớp 4. */
  const withCellLayer4 = async (clearLowConfidence: boolean, confidence: number, headerIsGuidance = false) => {
    const ctx = await importAtExtracting()
    const ref = await DocBlock.findOne({ projectId: ctx.projectId, section_id: "fixed:4.2.3", kind: "paragraph" }).lean()
    expect(ref, "cần block ở fixed:4.2.3 làm mẫu").toBeTruthy()
    const base = { projectId: ref!.projectId, doc_version: ref!.doc_version, section_id: "fixed:4.2.3", heading_path: ref!.heading_path, level: null, mentions: [], editable: true, locked_by_cr: null }
    const anchor = (xml_path: string, ordinal: number) => ({ bookmark: null, para_id: null, xml_path, ordinal })
    const cellText = "Describe the response time target here"
    await DocBlock.create([
      { ...base, block_id: "B9001", kind: "table", text: `Target
${cellText}`, text_hash: "t9001", rows: [["Target"], [cellText]], anchor: anchor("body/tbl[99]", 9001) },
      { ...base, block_id: "B9002", kind: "table_cell", text: "Target", text_hash: "t9002", ...(headerIsGuidance ? { guidance_layer: 3 } : {}), anchor: anchor("body/tbl[99]/tr[0]/tc[0]/p[0]", 9002) },
      { ...base, block_id: "B9003", kind: "table_cell", text: cellText, text_hash: "t9003", guidance_layer: 4, guidance_by: ["italic"], anchor: anchor("body/tbl[99]/tr[1]/tc[0]/p[0]", 9003) }
    ])
    const prompts: string[] = []
    mockOverrides.next = record((prompt) => {
      const out = fakeMode1(prompt)
      if (!out || !prompt.includes("# Import Extract")) return out
      const json = JSON.parse(out) as { items: { field_confidence: Record<string, number> }[]; guidance_blocks?: unknown[] }
      if (clearLowConfidence) for (const i of json.items) i.field_confidence = {}
      if (sectionOf(prompt) === "fixed:4.2.3") {
        prompts.push(prompt)
        // AI đọc cả bảng ⇒ nguồn của field là id khối bảng, không phải id ô
        for (const i of json.items as unknown as { source_block_ids: string[] }[]) i.source_block_ids = ["B9001"]
        json.guidance_blocks = [{ block_id: "B9003", is_guidance: true, confidence }]
      }
      return JSON.stringify(json)
    })
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    const tableFields = async () => ((await draftsOf(ctx.importId)).find((d) => d.section_id === "fixed:4.2.3")?.fields ?? []).filter((f) => f.source_block_ids.includes("B9001")).length
    const cell = async () => (await DocBlock.findOne({ projectId: ctx.projectId, block_id: "B9003" }).lean())?.guidance_layer
    return { ctx, run, prompts, cellText, cell, tableFields }
  }

  it("ô lớp 4 là ứng viên trong prompt, AI độ tin thấp ⇒ bản ghi lớp 4 chưa xác nhận, dừng fields_review, hiện ở review_guidance; xác nhận ⇒ ô lên lớp 3; không thêm lượt gọi AI", async () => {
    const { ctx, run, prompts, cellText, cell } = await withCellLayer4(false, 0.4)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(`B9003 (table cell: "${cellText}")`)
    // Chỉ ô nằm trong danh sách ứng viên: ô tiêu đề (không dấu hiệu) và id bảng thì không
    expect(prompts[0]).not.toContain("B9002 (table cell")
    expect(prompts[0]).not.toContain("B9001 (table cell")
    // không thêm lượt gọi AI: cùng 7 lượt như khi không có ô lớp 4
    expect(calls).toHaveLength(7)

    expect(run.doc.status).toBe("fields_review")
    const draft = (await draftsOf(ctx.importId)).find((d) => d.section_id === "fixed:4.2.3")!
    expect(draft.guidance_blocks).toEqual([expect.objectContaining({ block_id: "B9003", is_guidance: true, confidence: 0.4, confirmed: false })])
    const { extractionSummary } = await import("../../../src/modules/import/import.service.js")
    const summary = await extractionSummary(run.doc._id as unknown as string)
    expect(summary.review_guidance).toEqual([expect.objectContaining({ section_id: "fixed:4.2.3", block_id: "B9003", is_guidance: true, confirmed: false })])
    expect(await cell()).toBe(4)

    await patchFields(ctx.projectId, {
      import_id: ctx.importId,
      fields: [],
      guidance: [{ section_id: "fixed:4.2.3", block_id: "B9003", is_guidance: true }],
      content_mismatch: [],
      confirm_all: false
    })
    expect(await cell()).toBe(3)
  })

  it("AI độ tin cao ⇒ ô không tự lên lớp 3 (giữ lớp 4, nội dung thật); chỉ xác nhận của người mới nâng lớp", async () => {
    const { ctx, run, prompts, cell } = await withCellLayer4(true, 0.9)
    expect(prompts).toHaveLength(1)
    expect(calls).toHaveLength(7)
    expect(run.doc.status).toBe("baselining")
    expect(await cell()).toBe(4)
    const draft = (await draftsOf(ctx.importId)).find((d) => d.section_id === "fixed:4.2.3")!
    expect(draft.guidance_blocks).toEqual([expect.objectContaining({ block_id: "B9003", confirmed: false })])
  })

  const confirmCell = (ctx: { projectId: string; importId: string }) =>
    patchFields(ctx.projectId, { import_id: ctx.importId, fields: [], guidance: [{ section_id: "fixed:4.2.3", block_id: "B9003", is_guidance: true }], content_mismatch: [], confirm_all: false })

  it("bảng không còn ô nội dung thật ⇒ field nguồn là bảng bị bỏ (mục thành thiếu)", async () => {
    const { ctx, cell, tableFields } = await withCellLayer4(false, 0.4, true)
    expect(await tableFields()).toBeGreaterThan(0)
    await confirmCell(ctx)
    expect(await cell()).toBe(3)
    expect(await tableFields()).toBe(0)
  })

  it("bảng còn ô nội dung thật ⇒ giữ field", async () => {
    const { ctx, cell, tableFields } = await withCellLayer4(false, 0.4, false)
    const before = await tableFields()
    expect(before).toBeGreaterThan(0)
    await confirmCell(ctx)
    expect(await cell()).toBe(3)
    expect(await tableFields()).toBe(before)
  })
})
