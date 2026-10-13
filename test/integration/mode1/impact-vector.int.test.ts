/**
 * C-3 hybrid retrieval trên project đã import: ứng viên Atlas Vector Search (`vectorCandidates`, stub ở đây vì Mongo
 * in-memory không có `$vectorSearch`) thay nguồn từ khoá; vị trí đồ thị giữ nguyên. Không có vector ⇒ như cũ.
 * Hàm thuần (merge / trần) ở `src/modules/change-request/hybrid-retrieval.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
const vectorCandidates = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as { ref: string; score: number }[]))
vi.mock("../../../src/modules/change-request/embedding/vector-search.js", () => ({ vectorCandidates }))

import { detail, importedProject, lockedPaths, newCr, resetCrMock, PERF_TARGETS } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"

/** C-2 không nêu đích nào; từ khoá tiếng Anh tài liệu không dùng ⇒ tìm theo chữ ra 0 vị trí. */
const IDLE_TARGETS = { entity_paths: [], keywords: ["session timeout"] }
const LOGIN = "functions[id=FR-3.2.2]"

beforeEach(() => {
  vectorCandidates.mockReset().mockResolvedValue([])
})

const toImpactReview = async (targets: { entity_paths: string[]; keywords: string[] }, title: string, description: string) => {
  resetCrMock((p) => fakeCrClarify(targets)(p) ?? fakeCrPropose(p))
  const ctx = await importedProject()
  const crId = await newCr(ctx.c, title, description)
  detail(await ctx.c.post(`/change-requests/${crId}/clarify`))
  return { ...ctx, crId, cr: `/change-requests/${crId}` }
}

describe("C-3 hybrid retrieval", () => {
  it("đồng nghĩa VI–EN mà từ khoá trượt: không có vector ⇒ CR_NO_LOCATIONS; có ⇒ vị trí `vector` kèm điểm, bỏ phần tử đã xoá", async () => {
    const { c, cr, projectId, crId } = await toImpactReview(IDLE_TARGETS, "Tự đăng xuất khi không thao tác", "Người học bị đăng xuất sau 15 phút không thao tác.")
    const none = await c.post(`${cr}/impact`)
    expect(none.status).toBe(409)
    expect(none.body.error.code).toBe("CR_NO_LOCATIONS")

    // dòng index cũ của phần tử không còn trong Spine (`actors[id=A99]`) không được thành vị trí
    vectorCandidates.mockResolvedValue([
      { ref: "actors[id=A99]", score: 0.95 },
      { ref: LOGIN, score: 0.87 }
    ])
    const d = detail(await c.post(`${cr}/impact`))
    expect(d.locations.map((l) => [l.path, l.found_by, l.vector_score])).toEqual([[LOGIN, ["vector"], 0.87]])
    expect(await lockedPaths(projectId, crId)).toEqual([LOGIN])
    expect((await ChangeLocation.findOne({ projectId, cr_id: crId }).lean())?.vector_score).toBe(0.87)

    // query = tiêu đề + mô tả + từ khoá C-2
    const [pid, query] = vectorCandidates.mock.calls.at(-1)!
    expect(pid).toBe(projectId)
    expect(query).toContain("Tự đăng xuất khi không thao tác")
    expect(query).toContain("15 phút")
    expect(query).toContain("session timeout")
  })

  it("vị trí đồ thị giữ nguyên; vector thay từ khoá (BR-01 chỉ khớp chữ không còn); trùng đích ⇒ gộp found_by", async () => {
    const { c, cr } = await toImpactReview(PERF_TARGETS, "Faster response time", "Response time must be 1 second instead of 2 seconds.")
    vectorCandidates.mockResolvedValue([
      { ref: "nfrs[id=NFR-01]", score: 0.93 },
      { ref: LOGIN, score: 0.81 }
    ])
    const d = detail(await c.post(`${cr}/impact`))
    const byPath = new Map(d.locations.map((l) => [l.path, l]))
    expect(byPath.get("nfrs[id=NFR-01]")).toMatchObject({ found_by: ["spine_link", "vector"], vector_score: 0.93 })
    expect(byPath.get(LOGIN)).toMatchObject({ found_by: ["vector"], vector_score: 0.81 })
    expect(byPath.has("business_rules[id=BR-01]")).toBe(false)
    expect(d.locations.some((l) => l.found_by.includes("keyword"))).toBe(false)
  })

  it("không có ứng viên vector ⇒ y như trước: từ khoá tìm BR-01, vector_score null", async () => {
    const { c, cr } = await toImpactReview(PERF_TARGETS, "Faster response time", "Response time must be 1 second instead of 2 seconds.")
    const d = detail(await c.post(`${cr}/impact`))
    const byPath = new Map(d.locations.map((l) => [l.path, l]))
    expect(byPath.get("nfrs[id=NFR-01]")?.found_by.sort()).toEqual(["keyword", "spine_link"])
    expect(byPath.get("business_rules[id=BR-01]")?.found_by).toEqual(["keyword"])
    expect(d.locations.every((l) => l.vector_score === null)).toBe(true)
    expect(vectorCandidates).toHaveBeenCalledTimes(1)
  })
})
