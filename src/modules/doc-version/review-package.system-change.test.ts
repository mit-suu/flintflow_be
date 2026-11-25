/**
 * FLF-466 phase 02: Gói duyệt gom CR + thay đổi hệ thống sau lần phát hành trước; release kiểm Spine không đổi nội dung kể từ lúc gửi.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  versions: [] as Record<string, unknown>[],
  firstFind: null as { seq: number } | null,
  later: false,
  query: null as unknown
}))

vi.mock("./doc-version.service.js", () => ({ listDocVersions: vi.fn(async () => db.versions) }))
vi.mock("../spine/change.model.js", () => ({
  Change: {
    findOne: vi.fn(async () => db.firstFind),
    exists: vi.fn(async (q: unknown) => {
      db.query = q
      return db.later ? { _id: "x" } : null
    })
  }
}))

import { assertPackageUnchangedSinceSubmit, draftLabel, pendingCrIds } from "./review-package.service.js"

const v = (version: string, kind: string, at: string, extra: Record<string, unknown> = {}) => ({ version, kind, createdAt: new Date(at), cr_ids: [], created_by: "u1", system_change: null, ...extra })

beforeEach(() => {
  db.versions = []
  db.firstFind = null
  db.later = false
  db.query = null
})

describe("pendingCrIds - gói gồm CR và thay đổi hệ thống", () => {
  it("gom cr_revision + system_change sau lần phát hành gần nhất, theo thứ tự ghi; bỏ những gì trước lần phát hành", async () => {
    db.versions = [
      v("1.3", "system_change", "2026-11-05", { system_change: { type: "screen_mockup", ref: "r3", summary: "Vẽ lại bằng mockup 2 màn hình" } }),
      v("1.2", "cr_revision", "2026-11-04", { cr_ids: ["CR-013"] }),
      v("1.1", "system_change", "2026-11-03", { system_change: { type: "template_migration", ref: "m1", summary: "Đổi mẫu sang Sở XD v3" } }),
      v("1.0", "release", "2026-11-02", { cr_ids: ["CR-011"] }),
      v("0.2", "system_change", "2026-11-01", { system_change: { type: "template_migration", ref: "old", summary: "đã phát hành" } }),
      v("0.1", "imported", "2026-10-30")
    ]
    const res = await pendingCrIds("p1")
    expect(res.crIds).toEqual(["CR-013"])
    expect(res.systemChanges.map((s) => [s.version, s.type, s.summary])).toEqual([
      ["1.1", "template_migration", "Đổi mẫu sang Sở XD v3"],
      ["1.3", "screen_mockup", "Vẽ lại bằng mockup 2 màn hình"]
    ])
    expect(res.latest).toBe("1.3")
    expect(res.base).toBe("1.0")
  })

  it("gói chỉ có thay đổi hệ thống vẫn có nội dung (crIds rỗng, systemChanges có mục)", async () => {
    db.versions = [v("1.1", "system_change", "2026-11-03", { system_change: { type: "template_revert", ref: "m1:revert", summary: "Hoàn tác đổi mẫu" } }), v("1.0", "release", "2026-11-02")]
    const res = await pendingCrIds("p1")
    expect(res.crIds).toEqual([])
    expect(res.systemChanges).toHaveLength(1)
    expect(draftLabel(res.base, res.crIds.length + res.systemChanges.length)).toBe("1.0 · 1 thay đổi chưa duyệt")
  })
})

describe("assertPackageUnchangedSinceSubmit - Lead duyệt đúng bản đã gửi", () => {
  const pending = { status: "pending" } as never

  it("không có gói chờ duyệt (Lead tự phát hành) ⇒ không kiểm", async () => {
    await expect(assertPackageUnchangedSinceSubmit("p1", null)).resolves.toBeUndefined()
    await expect(assertPackageUnchangedSinceSubmit("p1", { status: "rejected" } as never)).resolves.toBeUndefined()
  })

  it("không có Change nội dung nào sau lần gửi (cờ / tiến độ tự tính không tính) ⇒ cho phát hành", async () => {
    db.firstFind = { seq: 40 }
    await expect(assertPackageUnchangedSinceSubmit("p1", pending)).resolves.toBeUndefined()
    const q = db.query as { seq: { $gt: number }; path: { $not: RegExp } }
    expect(q.seq.$gt).toBe(40)
    // cờ / tiến độ / gửi duyệt không phải thay đổi nội dung
    expect(q.path.$not.test("flags[id=F1].resolved_at")).toBe(true)
    expect(q.path.$not.test("progress")).toBe(true)
    expect(q.path.$not.test("screens[id=S1].name")).toBe(false)
  })

  it("Spine đã đổi nội dung sau lần gửi (đổi mẫu, vẽ lại màn, CR) ⇒ 409 PACKAGE_CHANGED_AFTER_SUBMIT", async () => {
    db.firstFind = { seq: 40 }
    db.later = true
    await expect(assertPackageUnchangedSinceSubmit("p1", pending)).rejects.toMatchObject({ code: "PACKAGE_CHANGED_AFTER_SUBMIT", statusCode: 409 })
  })
})
