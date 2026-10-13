import { describe, it, expect, vi, beforeEach } from "vitest"
import mongoose from "mongoose"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Spine } from "../../spine/spine.types.js"

type Row = { projectId: string; kind: string; ref: string; text_hash: string; spine_version: number; text: string; embedding: number[] }
const store = vi.hoisted(() => ({ rows: [] as Row[], spine: null as unknown, supported: true, available: true }))
const embedTexts = vi.hoisted(() => vi.fn(async (texts: readonly string[]) => texts.map((_, i) => [i, 1])))

vi.mock("../../../shared/ai/embedding/embedding.provider.js", () => ({
  embeddingAvailable: () => store.available,
  embeddingModelId: () => "mock-bow-2",
  embedTexts
}))
vi.mock("./vector-search.js", () => ({ isVectorSearchSupported: async () => store.supported }))
vi.mock("../../spine/spine.repository.js", async (orig) => ({ ...(await orig<typeof import("../../spine/spine.repository.js")>()), get: async () => store.spine }))
vi.mock("./spine-embedding.model.js", () => {
  const match = (f: Record<string, unknown>, r: Row) =>
    String(f.projectId) === r.projectId && f.kind === r.kind && (typeof f.ref === "object" ? (f.ref as { $in: string[] }).$in.includes(r.ref) : f.ref === undefined || f.ref === r.ref)
  return {
    SpineEmbedding: {
      find: (f: Record<string, unknown>) => ({ select: () => ({ lean: async () => store.rows.filter((r) => match(f, r)) }) }),
      bulkWrite: async (ops: { updateOne: { filter: Record<string, unknown>; update: { $set: Partial<Row> } } }[]) => {
        for (const { updateOne } of ops) {
          const cur = store.rows.find((r) => match(updateOne.filter, r))
          if (cur) Object.assign(cur, updateOne.update.$set)
          else store.rows.push({ projectId: String(updateOne.filter.projectId), kind: "element", ref: String(updateOne.filter.ref), ...updateOne.update.$set } as Row)
        }
      },
      deleteMany: async (f: Record<string, unknown>) => {
        store.rows = store.rows.filter((r) => !match(f, r))
      },
      updateMany: async (f: Record<string, unknown>, u: { $set: Partial<Row> }) => {
        for (const r of store.rows.filter((x) => match(f, x))) Object.assign(r, u.$set)
      }
    }
  }
})

import { pendingEmbeddingSync, scheduleEmbeddingSync, syncProjectEmbeddings } from "./embedding-sync.service.js"

const PID = new mongoose.Types.ObjectId().toHexString()
const spine = (version: number): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.spine_version = version
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "Studies." } as never, { id: "A02", name: "Admin", kind: "human", description: "Manages." } as never)
  return s
}

beforeEach(() => {
  Object.assign(store, { rows: [], spine: spine(1), supported: true, available: true })
  embedTexts.mockClear()
})

describe("syncProjectEmbeddings", () => {
  it("lần đầu embed mọi phần tử; lần sau chỉ phần tử đổi chữ, xoá phần tử mất, nâng spine_version phần còn lại", async () => {
    expect(await syncProjectEmbeddings(PID)).toEqual({ embedded: 3, removed: 0, kept: 0 })
    expect(store.rows.map((r) => r.ref).sort()).toEqual(["actors[id=A01]", "actors[id=A02]", "project"])
    expect(embedTexts).toHaveBeenCalledWith(expect.arrayContaining(["Actor A01: Learner\nkind: human\ndescription: Studies."]), { taskType: "RETRIEVAL_DOCUMENT" })

    const next = spine(2)
    next.actors[0]!.description = "Studies online."
    next.actors.splice(1, 1)
    store.spine = next
    embedTexts.mockClear()
    expect(await syncProjectEmbeddings(PID)).toEqual({ embedded: 1, removed: 1, kept: 1 })
    expect(embedTexts).toHaveBeenCalledWith(["Actor A01: Learner\nkind: human\ndescription: Studies online."], { taskType: "RETRIEVAL_DOCUMENT" })
    expect(store.rows.map((r) => [r.ref, r.spine_version]).sort()).toEqual([
      ["actors[id=A01]", 2],
      ["project", 2]
    ])
  })

  it("embedding tắt / Mongo không có $vectorSearch / không có Spine ⇒ bỏ qua, không embed", async () => {
    store.available = false
    expect(await syncProjectEmbeddings(PID)).toBeNull()
    store.available = true
    store.supported = false
    expect(await syncProjectEmbeddings(PID)).toBeNull()
    store.supported = true
    store.spine = null
    expect(await syncProjectEmbeddings(PID)).toBeNull()
    expect(embedTexts).not.toHaveBeenCalled()
  })
})

describe("scheduleEmbeddingSync", () => {
  it("không ném dù provider lỗi; index giữ nguyên", async () => {
    embedTexts.mockRejectedValueOnce(new Error("503 overloaded"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(() => scheduleEmbeddingSync(PID)).not.toThrow()
    await pendingEmbeddingSync(PID)
    expect(store.rows).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("đồng bộ index embedding lỗi"))
    warn.mockRestore()
  })

  it("gọi dồn khi đang chạy ⇒ một lượt chạy lại sau cùng (không chạy song song)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    scheduleEmbeddingSync(PID)
    scheduleEmbeddingSync(PID)
    scheduleEmbeddingSync(PID)
    await pendingEmbeddingSync(PID)
    // lượt 1 embed 3 phần tử, lượt gộp không còn gì đổi
    expect(embedTexts).toHaveBeenCalledTimes(1)
    expect(store.rows).toHaveLength(3)
    log.mockRestore()
  })

  it("embedding tắt ⇒ không làm gì", async () => {
    store.available = false
    scheduleEmbeddingSync(PID)
    await pendingEmbeddingSync(PID)
    expect(store.rows).toEqual([])
  })
})
