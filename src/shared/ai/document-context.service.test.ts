import { beforeEach, describe, expect, it, vi } from "vitest"

interface DocRow {
  _id: string
  originalName: string
  extractedText: string
  summary: string | null
  summaryStatus: string
  tokenCount: number | null
  docCode: number
}

const store = vi.hoisted(() => ({ docs: [] as DocRow[], finds: 0, textReads: 0 }))

vi.mock("../../modules/project/project-document.model.js", () => ({
  ProjectDocument: {
    find: vi.fn((filter: { _id?: unknown }) => {
      store.finds++
      if (filter._id) store.textReads++
      const query = { select: () => query, sort: () => query, lean: async () => store.docs.map((d) => ({ ...d, _id: { toString: () => d._id } })) }
      return query
    })
  }
}))
vi.mock("../../modules/project/document-code.service.js", () => ({ assignDocCodes: vi.fn(async () => undefined) }))
vi.mock("./document-retrieval/chunk-index.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./document-retrieval/chunk-index.service.js")>()
  const { chunkParagraphs } = await import("./document-retrieval/chunker.js")
  const { splitParagraphs } = await import("./document-paragraphs.js")
  return {
    ...actual,
    loadProjectIndex: vi.fn(async (refs: { id: string; docCode: number; name: string }[]) =>
      actual.buildProjectIndex(refs.map((ref) => ({ ref, chunks: chunkParagraphs(splitParagraphs(store.docs.find((d) => d._id === ref.id)!.extractedText)) })))
    )
  }
})

import { env } from "../../config/env.js"
import { ActionType } from "./ai-action.types.js"
import { buildDocumentContext, documentBudgetFor, stepNeedsSourceDocuments } from "./document-context.service.js"
import { parseParagraphId, splitParagraphs } from "./document-paragraphs.js"

const doc = (id: string, code: number, text: string, summary: string | null = null): DocRow => ({
  _id: id,
  originalName: `${id}.txt`,
  extractedText: text,
  summary,
  summaryStatus: summary ? "success" : "pending",
  tokenCount: Math.ceil(text.length / 4),
  docCode: code
})

const useCase = (n: number, name: string): string =>
  [`UC-${String(n).padStart(2, "0")} ${name}`, ...Array.from({ length: 6 }, (_, i) => `Bước ${i + 1} của ${name}: hệ thống kiểm tra dữ liệu, ghi nhận kết quả và thông báo cho người dùng liên quan đến ${name}.`)].join("\n\n")

/** SRS giả ~40k token: 150 use case + mục phi chức năng — vượt mọi trần mặc định. */
const BIG_SRS = [
  "1 Giới thiệu",
  "Tài liệu đặc tả hệ thống đặt lịch khám.",
  "2 Yêu cầu người dùng",
  "2.2 Use Cases",
  ...Array.from({ length: 150 }, (_, i) => useCase(i + 1, i === 36 ? "Hoàn tiền khi huỷ lịch" : `Chức năng nghiệp vụ số ${i + 1}`)),
  "4 Yêu cầu phi chức năng",
  "4.2.3 Hiệu năng",
  "Trang thanh toán phải phản hồi trong 3 giây với 500 người dùng đồng thời."
].join("\n\n")

const SMALL = "Biên bản họp kick-off\n\nKhách hàng, người bán và admin dùng hệ thống.\n\nTrang thanh toán phải xong trong 3 giây."

/** Mọi dòng `[D1-Pxx] chữ` trong context phải đúng là đoạn xx của tài liệu gốc. */
const expectCodesResolve = (contextText: string, text: string): number => {
  const paragraphs = splitParagraphs(text)
  let checked = 0
  for (const line of contextText.split("\n")) {
    const m = /^\[(D\d+-P\d+)\] (.*)$/.exec(line)
    if (!m) continue
    const id = parseParagraphId(m[1]!)
    expect(paragraphs[id!.index], m[1]).toBe(m[2])
    checked++
  }
  return checked
}

beforeEach(() => {
  store.docs = []
  store.finds = 0
  store.textReads = 0
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

describe("buildDocumentContext (FLF-393)", () => {
  it("action / step không đọc tài liệu ⇒ rỗng, không đọc DB", async () => {
    store.docs = [doc("d1", 1, SMALL)]
    expect(stepNeedsSourceDocuments("S-3.4")).toBe(false)
    expect((await buildDocumentContext({ projectId: "p", actionType: ActionType.DRAFT, stepId: "S-3.4" })).mode).toBe("none")
    expect((await buildDocumentContext({ projectId: "p", actionType: ActionType.DRAFT })).mode).toBe("none")
    expect((await buildDocumentContext({ projectId: "p", actionType: ActionType.SUMMARIZE_DOCUMENT })).contextText).toBe("")
    expect(store.finds).toBe(0)
  })

  it("không có tài liệu ⇒ rỗng", async () => {
    expect(await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT })).toMatchObject({ contextText: "", mode: "none", documentsUsed: 0 })
  })

  it("tài liệu vừa trần ⇒ nguyên văn như trước, có mã đoạn", async () => {
    store.docs = [doc("d1", 1, SMALL), doc("d2", 2, "Email khách hàng\n\nChỉ nhận thanh toán online, không COD.")]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "bất kỳ" })
    expect(ctx).toMatchObject({ mode: "full", documentsUsed: 2, usedSummary: false, chunksUsed: 0 })
    expect(ctx.contextText).toContain("[Nguồn: d1.txt | documentId: d1 | mã tài liệu: D1]")
    expect(ctx.contextText).toContain("[D1-P03] Trang thanh toán phải xong trong 3 giây.")
    expect(ctx.contextText).toContain("[D2-P02] Chỉ nhận thanh toán online, không COD.")
    expect(ctx.contextText).not.toContain("trích đoạn")
  })

  it("chat với SRS lớn: chỉ đoạn liên quan, dưới trần, không nạp toàn văn, mã đoạn vẫn đúng", async () => {
    store.docs = [doc("d1", 1, BIG_SRS)]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "UC-37 xử lý thế nào?" })
    expect(ctx.mode).toBe("retrieved")
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_CHAT_TOKENS)
    expect(ctx.fullTokens).toBeGreaterThan(env.DOC_CONTEXT_CHAT_TOKENS * 2)
    expect(ctx.chunksUsed).toBeGreaterThan(0)
    expect(ctx.chunksUsed).toBeLessThanOrEqual(env.DOC_CONTEXT_TOP_K)
    expect(ctx.contextText).toContain("UC-37 Hoàn tiền khi huỷ lịch")
    expect(ctx.contextText).toContain("mục: 2 Yêu cầu người dùng > 2.2 Use Cases")
    expect(ctx.contextText).toContain("trích đoạn")
    expect(expectCodesResolve(ctx.contextText, BIG_SRS)).toBeGreaterThan(3)
    expect(store.textReads).toBe(0)
  })

  it("chat: hỏi bằng tiếng Việt không dấu vẫn ra đúng đoạn", async () => {
    store.docs = [doc("d1", 1, BIG_SRS)]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "hoan tien khi huy lich" })
    expect(ctx.contextText).toContain("UC-37 Hoàn tiền khi huỷ lịch")
  })

  it("chat: câu hỏi toàn cục ⇒ kèm tóm tắt tài liệu", async () => {
    store.docs = [doc("d1", 1, BIG_SRS, "SRS của hệ thống đặt lịch khám: 150 use case, yêu cầu hiệu năng.")]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "tóm tắt tài liệu giúp mình" })
    expect(ctx.usedSummary).toBe(true)
    expect(ctx.contextText).toContain("[Tóm tắt tài liệu: d1.txt | mã tài liệu: D1]")
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_CHAT_TOKENS)
    // câu hỏi cụ thể thì không kèm tóm tắt
    expect((await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "UC-37" })).usedSummary).toBe(false)
  })

  it("không khớp gì và không có tóm tắt ⇒ phần đầu tài liệu, không bao giờ rỗng", async () => {
    store.docs = [doc("d1", 1, BIG_SRS)]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "blockchain" })
    expect(ctx.mode).toBe("retrieved")
    expect(ctx.contextText).toContain("[D1-P01] 1 Giới thiệu")
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_CHAT_TOKENS)
  })

  it("Draft: chunk của section step nuôi được ghim dù câu hỏi không nhắc tới", async () => {
    store.docs = [doc("d1", 1, BIG_SRS)]
    const ctx = await buildDocumentContext({
      projectId: "p",
      actionType: ActionType.DRAFT,
      stepId: "S-6.4",
      query: "Performance",
      sectionTitles: ["Performance", "Hiệu năng"]
    })
    expect(ctx.mode).toBe("retrieved")
    expect(ctx.contextText).toContain("Trang thanh toán phải phản hồi trong 3 giây")
    expect(ctx.usedSummary).toBe(false)
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_DRAFT_TOKENS)
  })

  it("Draft của step không nuôi mục nào của tài liệu (Brief) ⇒ BM25 + tóm tắt", async () => {
    store.docs = [doc("d1", 1, BIG_SRS, "SRS của hệ thống đặt lịch khám.")]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.DRAFT, stepId: "B-0.1", query: "Brain Dump\nhoàn tiền", sectionTitles: [] })
    expect(ctx.usedSummary).toBe(true)
    expect(ctx.contextText).toContain("UC-37 Hoàn tiền khi huỷ lịch")
    expect(ctx.tokenCount).toBeLessThanOrEqual(env.DOC_CONTEXT_DRAFT_TOKENS)
  })

  it("nhiều tài liệu: tài liệu nhỏ đi cùng SRS lớn vẫn tìm được, nhãn nguồn đúng tài liệu", async () => {
    store.docs = [doc("d1", 1, BIG_SRS), doc("d2", 2, "Email khách hàng\n\nChỉ nhận thanh toán online qua ví MoMo, không COD.")]
    const ctx = await buildDocumentContext({ projectId: "p", actionType: ActionType.CHAT, query: "ví MoMo" })
    expect(ctx.contextText).toContain("[Nguồn: d2.txt | documentId: d2 | mã tài liệu: D2")
    expect(ctx.contextText).toContain("[D2-P02] Chỉ nhận thanh toán online qua ví MoMo, không COD.")
  })

  it("trần theo loại lượt gọi, không theo model", () => {
    expect(documentBudgetFor(ActionType.CHAT)).toBe(env.DOC_CONTEXT_CHAT_TOKENS)
    for (const action of [ActionType.DRAFT, ActionType.REVISION, ActionType.REGENERATE]) expect(documentBudgetFor(action)).toBe(env.DOC_CONTEXT_DRAFT_TOKENS)
  })
})
