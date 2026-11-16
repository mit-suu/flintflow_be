import { beforeEach, describe, expect, it, vi } from "vitest"

interface ChunkRow {
  documentId: string
  chunker_version: number
  ordinal: number
  heading_path: string[]
  titles: string[]
  p_start: number
  p_end: number
  paragraphs: string[]
  tokens: number
}

const store = vi.hoisted(() => ({
  chunks: [] as ChunkRow[],
  documents: new Map<string, { projectId: string; extractedText: string | null; outline?: { p: number; level: number }[] }>(),
  chunkFinds: 0,
  failInsert: false
}))

vi.mock("../../../modules/project/project-document-chunk.model.js", () => ({
  ProjectDocumentChunk: {
    find: vi.fn((filter: { documentId: { $in: string[] }; chunker_version: number }) => {
      store.chunkFinds++
      const rows = store.chunks
        .filter((c) => filter.documentId.$in.includes(c.documentId) && c.chunker_version === filter.chunker_version)
        .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal)
      const query = { sort: () => query, lean: async () => rows }
      return query
    }),
    deleteMany: vi.fn(async (filter: { documentId: string }) => {
      store.chunks = store.chunks.filter((c) => c.documentId !== String(filter.documentId))
    }),
    insertMany: vi.fn(async (rows: ChunkRow[]) => {
      if (store.failInsert) throw new Error("E11000 duplicate key")
      store.chunks.push(...rows.map((r) => ({ ...r, documentId: String(r.documentId) })))
    })
  }
}))
vi.mock("../../../modules/project/project-document.model.js", () => ({
  ProjectDocument: {
    findById: vi.fn((id: string) => {
      const query = { select: () => query, lean: async () => store.documents.get(String(id)) ?? null }
      return query
    })
  }
}))

import { searchBm25 } from "./bm25.js"
import { CHUNKER_VERSION } from "./chunker.js"
import { buildProjectIndex, clearChunkIndexCache, deleteDocumentChunks, loadProjectIndex, saveDocumentChunks } from "./chunk-index.service.js"
import { tokenize } from "./vi-tokenizer.js"

const SRS = ["1 Giới thiệu", "Hệ thống đặt lịch khám.", "2 Use Cases", "UC-01 Đăng nhập", "Khách hàng nhập email và mật khẩu.", "UC-02 Đặt lịch", "Khách hàng chọn bác sĩ và khung giờ."].join("\n\n")
const MINUTES = "Biên bản họp\n\nKhách hàng yêu cầu thanh toán online qua ví điện tử."

const REFS = [
  { id: "doc1", docCode: 1, name: "srs.txt" },
  { id: "doc2", docCode: 2, name: "minutes.txt" }
]

beforeEach(() => {
  store.chunks = []
  store.documents = new Map([
    ["doc1", { projectId: "p1", extractedText: SRS }],
    ["doc2", { projectId: "p1", extractedText: MINUTES }]
  ])
  store.chunkFinds = 0
  store.failInsert = false
  clearChunkIndexCache()
})

describe("buildProjectIndex (FLF-393)", () => {
  it("id chunk duy nhất theo tài liệu, giữ thứ tự tài liệu, tìm được qua BM25", () => {
    const base = { heading_path: [], titles: [], p_start: 0, p_end: 0, tokens: 10 }
    const index = buildProjectIndex([
      { ref: REFS[0]!, chunks: [{ ...base, ordinal: 0, paragraphs: ["UC-01 Đăng nhập hệ thống"] }] },
      { ref: REFS[1]!, chunks: [{ ...base, ordinal: 0, paragraphs: ["Thanh toán online"] }] }
    ])
    expect(index.chunks.map((c) => [c.id, c.docCode, c.docName])).toEqual([
      ["doc1:0", 1, "srs.txt"],
      ["doc2:0", 2, "minutes.txt"]
    ])
    expect(searchBm25(index.bm25, tokenize("thanh toan"), 1)[0]?.id).toBe("doc2:0")
  })
})

describe("loadProjectIndex (FLF-393)", () => {
  it("tài liệu chưa có chunk được dựng bù và lưu lại", async () => {
    const index = await loadProjectIndex(REFS)
    expect(index.chunks.length).toBeGreaterThan(1)
    expect(new Set(store.chunks.map((c) => c.documentId))).toEqual(new Set(["doc1", "doc2"]))
    expect(store.chunks.every((c) => c.chunker_version === CHUNKER_VERSION)).toBe(true)
    expect(searchBm25(index.bm25, tokenize("UC-02"), 1)[0]?.id).toMatch(/^doc1:/)
  })

  it("cache: lượt sau cùng tập tài liệu không đọc DB; thêm tài liệu ⇒ dựng lại", async () => {
    const first = await loadProjectIndex(REFS)
    expect(await loadProjectIndex(REFS)).toBe(first)
    expect(store.chunkFinds).toBe(1)
    await loadProjectIndex(REFS.slice(0, 1))
    expect(store.chunkFinds).toBe(2)
  })

  it("chunk của phiên bản chunker cũ bị coi là thiếu ⇒ dựng lại", async () => {
    store.chunks.push({ documentId: "doc1", chunker_version: CHUNKER_VERSION - 1, ordinal: 0, heading_path: [], titles: [], p_start: 0, p_end: 0, paragraphs: ["cũ"], tokens: 1 })
    const index = await loadProjectIndex(REFS.slice(0, 1))
    expect(index.chunks.some((c) => c.paragraphs.includes("cũ"))).toBe(false)
    expect(store.chunks.every((c) => c.chunker_version === CHUNKER_VERSION)).toBe(true)
  })

  it("lưu lỗi (hai request cùng dựng bù) không ném — chunk vừa cắt vẫn dùng được", async () => {
    store.failInsert = true
    const index = await loadProjectIndex(REFS)
    expect(index.chunks.length).toBeGreaterThan(1)
  })

  it("tài liệu không còn chữ ⇒ không có chunk", async () => {
    store.documents.set("doc2", { projectId: "p1", extractedText: null })
    const index = await loadProjectIndex(REFS)
    expect(index.chunks.every((c) => c.documentId === "doc1")).toBe(true)
  })
})

describe("saveDocumentChunks / deleteDocumentChunks (FLF-393)", () => {
  it("ghi đè chunk cũ của tài liệu; xoá tài liệu xoá chunk", async () => {
    await saveDocumentChunks("p1", "doc1", SRS)
    const count = store.chunks.length
    await saveDocumentChunks("p1", "doc1", SRS)
    expect(store.chunks.length).toBe(count)
    await deleteDocumentChunks("doc1")
    expect(store.chunks).toEqual([])
  })
})
