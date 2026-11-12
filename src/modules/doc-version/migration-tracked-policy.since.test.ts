import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({ migrations: [] as { translated?: boolean; applied_at: Date; state: string }[] }))
vi.mock("../template-migration/template-migration.model.js", () => ({
  TemplateMigration: {
    find: (filter: { state: string; applied_at: { $gt: Date } }) => ({
      lean: async () => store.migrations.filter((m) => m.state === filter.state && m.applied_at > filter.applied_at.$gt)
    })
  }
}))

const { trackedPolicySince } = await import("./migration-tracked-policy.js")

const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`)

describe("trackedPolicySince", () => {
  beforeEach(() => {
    store.migrations = []
  })

  it("không có lần đổi mẫu nào sau version trước ⇒ normal (kể cả lần đổi mẫu trước version đó có dịch)", async () => {
    store.migrations = [{ state: "applied", translated: true, applied_at: at(5) }]
    expect(await trackedPolicySince("p", at(10))).toBe("normal")
  })

  it("có lần đổi mẫu không dịch ⇒ content_only; chỉ cần MỘT lần có dịch sau mốc ⇒ none (không lấy lần mới nhất)", async () => {
    store.migrations = [{ state: "applied", translated: false, applied_at: at(12) }]
    expect(await trackedPolicySince("p", at(10))).toBe("content_only")
    store.migrations = [
      { state: "applied", translated: true, applied_at: at(12) },
      { state: "applied", translated: false, applied_at: at(15) }
    ]
    expect(await trackedPolicySince("p", at(10))).toBe("none")
  })

  it("lần đổi mẫu đã hoàn tác không tính", async () => {
    store.migrations = [{ state: "reverted", translated: true, applied_at: at(12) }]
    expect(await trackedPolicySince("p", at(10))).toBe("normal")
  })
})
