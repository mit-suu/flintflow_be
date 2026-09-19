import { describe, expect, it } from "vitest"
import {
  LEGACY_SOURCE_MODE,
  migrateProjectSourceMode,
  type ProjectCollectionLike
} from "./migrate-project-source-mode.js"

interface Doc {
  name: string
  sourceMode?: string
}

/** Collection giả trong bộ nhớ, chỉ hiểu đúng filter `{ sourceMode: { $exists: false } }` script dùng. */
const fakeCollection = (docs: Doc[]): ProjectCollectionLike => ({
  countDocuments: async () => docs.filter((d) => d.sourceMode === undefined).length,
  updateMany: async (_filter, update) => {
    const targets = docs.filter((d) => d.sourceMode === undefined)
    for (const doc of targets) doc.sourceMode = update.$set.sourceMode
    return { modifiedCount: targets.length }
  }
})

describe("migrateProjectSourceMode", () => {
  it("chỉ gán fpt_template cho dự án chưa có mode, giữ nguyên mode đã chọn", async () => {
    const docs: Doc[] = [{ name: "cũ 1" }, { name: "mới", sourceMode: "edit_srs" }, { name: "cũ 2" }]

    await expect(migrateProjectSourceMode(fakeCollection(docs))).resolves.toBe(2)
    expect(docs.map((d) => d.sourceMode)).toEqual([LEGACY_SOURCE_MODE, "edit_srs", LEGACY_SOURCE_MODE])
  })

  it("chạy lần hai không đổi thêm gì (idempotent)", async () => {
    const docs: Doc[] = [{ name: "cũ" }]
    const projects = fakeCollection(docs)

    await migrateProjectSourceMode(projects)
    await expect(migrateProjectSourceMode(projects)).resolves.toBe(0)
    expect(docs).toEqual([{ name: "cũ", sourceMode: "fpt_template" }])
  })

  it("dry-run chỉ đếm, không ghi", async () => {
    const docs: Doc[] = [{ name: "cũ" }]

    await expect(migrateProjectSourceMode(fakeCollection(docs), { dryRun: true })).resolves.toBe(1)
    expect(docs[0].sourceMode).toBeUndefined()
  })
})
