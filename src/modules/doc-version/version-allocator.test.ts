/**
 * Cấp số version nguyên tử (FLF-466, red-team #4): hai đường ghi cùng lúc không nhận cùng một số, số cấp ra luôn nối tiếp số đã ghi,
 * khoá nhả cả khi lỗi, khoá của tiến trình chết tự hết hạn. Khoá giả lập trong bộ nhớ theo đúng ngữ nghĩa upsert + chỉ mục unique.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  locks: new Map<string, { token: string; expires_at: Date }>(),
  versions: [] as { version: string; createdAt: Date }[]
}))

vi.mock("./doc-version.service.js", () => ({
  latestDocVersion: vi.fn(async () => [...state.versions].sort((a, b) => Number(b.version.split(".")[0]) - Number(a.version.split(".")[0]) || Number(b.version.split(".")[1]) - Number(a.version.split(".")[1]))[0] ?? null)
}))

import { DOC_VERSION_BUSY, DocVersionLock, nextVersionAfter, withVersionSlot } from "./version-allocator.js"

const duplicateKey = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 })

beforeEach(() => {
  state.locks.clear()
  state.versions = [{ version: "1.0", createdAt: new Date() }]
  vi.spyOn(DocVersionLock, "findOneAndUpdate").mockImplementation((async (filter: { projectId: string; expires_at: { $lt: Date } }, update: { $set: { token: string; expires_at: Date } }) => {
    const held = state.locks.get(String(filter.projectId))
    // Bộ lọc `expires_at < now` không khớp khoá còn hạn ⇒ upsert chèn mới ⇒ đụng chỉ mục unique
    if (held && !(held.expires_at < filter.expires_at.$lt)) throw duplicateKey()
    state.locks.set(String(filter.projectId), { token: update.$set.token, expires_at: update.$set.expires_at })
    return null
  }) as never)
  vi.spyOn(DocVersionLock, "deleteOne").mockImplementation((async (filter: { projectId: string; token: string }) => {
    if (state.locks.get(String(filter.projectId))?.token === filter.token) state.locks.delete(String(filter.projectId))
    return { deletedCount: 1 }
  }) as never)
})

const fast = { sleep: async () => undefined }

describe("nextVersionAfter", () => {
  it("minor cho CR / thay đổi hệ thống, major cho phát hành", () => {
    expect(nextVersionAfter("1.0", "minor")).toBe("1.1")
    expect(nextVersionAfter("1.3", "minor")).toBe("1.4")
    expect(nextVersionAfter("1.3", "major")).toBe("2.0")
    expect(nextVersionAfter("0.1", "major")).toBe("1.0")
  })
})

describe("withVersionSlot", () => {
  it("cấp số kế tiếp của version mới nhất và nhả khoá sau khi xong", async () => {
    const got = await withVersionSlot("p1", "minor", async ({ latest, next }) => ({ based: latest.version, next }), fast)
    expect(got).toEqual({ based: "1.0", next: "1.1" })
    expect(state.locks.size).toBe(0)
  })

  it("nhả khoá khi lỗi", async () => {
    await expect(withVersionSlot("p1", "minor", async () => Promise.reject(new Error("boom")), fast)).rejects.toThrow("boom")
    expect(state.locks.size).toBe(0)
  })

  it("hai lượt cùng lúc (CR + thay đổi hệ thống): chạy nối tiếp, số khác nhau và liền nhau, không bao giờ trùng", async () => {
    const order: string[] = []
    const write = (label: string) =>
      withVersionSlot(
        "p1",
        "minor",
        async ({ next }) => {
          order.push(`${label}:start:${next}`)
          // Lượt kia chỉ thấy version mới sau khi lượt này ghi xong (còn giữ khoá)
          await new Promise((r) => setTimeout(r, 5))
          state.versions.push({ version: next, createdAt: new Date() })
          order.push(`${label}:done`)
          return next
        },
        // chờ thật vài ms để lượt sau thấy khoá bận rồi thử lại
        { sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))) }
      )
    const [a, b, c] = await Promise.all([write("cr"), write("redraw"), write("cr2")])
    expect(new Set([a, b, c]).size).toBe(3)
    expect([a, b, c].sort()).toEqual(["1.1", "1.2", "1.3"])
    // mỗi lượt xong hẳn trước khi lượt sau bắt đầu
    const starts = order.filter((o) => o.includes(":start:"))
    expect(order.indexOf(starts[1])).toBeGreaterThan(order.findIndex((o) => o.endsWith(":done")))
  })

  it("phát hành (major) xếp sau thay đổi minor đang ghi: ra 2.0 chứ không phải 1.x sau 2.0", async () => {
    const minor = withVersionSlot("p1", "minor", async ({ next }) => {
      await new Promise((r) => setTimeout(r, 5))
      state.versions.push({ version: next, createdAt: new Date() })
      return next
    }, { sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))) })
    const major = withVersionSlot("p1", "major", async ({ next }) => {
      state.versions.push({ version: next, createdAt: new Date() })
      return next
    }, { sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))) })
    expect(await Promise.all([minor, major])).toEqual(["1.1", "2.0"])
  })

  it("khoá bận quá hạn chờ ⇒ 409 DOC_VERSION_BUSY", async () => {
    state.locks.set("p1", { token: "other", expires_at: new Date(Date.now() + 60_000) })
    await expect(withVersionSlot("p1", "minor", async () => "x", { ...fast, waitMs: 0 })).rejects.toMatchObject({ statusCode: 409, code: DOC_VERSION_BUSY })
  })

  it("khoá của tiến trình đã chết (hết hạn) bị chiếm lại, không kẹt dự án", async () => {
    state.locks.set("p1", { token: "dead", expires_at: new Date(Date.now() - 1000) })
    await expect(withVersionSlot("p1", "minor", async ({ next }) => next, fast)).resolves.toBe("1.1")
  })

  it("chưa có version nào ⇒ DOC_VERSION_NOT_FOUND và vẫn nhả khoá", async () => {
    state.versions = []
    await expect(withVersionSlot("p1", "minor", async () => "x", fast)).rejects.toMatchObject({ code: "DOC_VERSION_NOT_FOUND" })
    expect(state.locks.size).toBe(0)
  })
})
