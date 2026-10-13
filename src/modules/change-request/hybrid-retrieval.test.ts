/**
 * C-3 hybrid retrieval — phần hàm thuần: ứng viên vector thay nguồn từ khoá, vị trí đồ thị giữ nguyên, trần ưu tiên
 * đồ thị rồi điểm vector. Chạy trên DB (stub `vectorCandidates`) ở `test/integration/mode1/impact-vector.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { MAX_LOCATIONS, capLocations, findSpineLocations, type FoundLocation } from "./spine-location.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "A person who enrolls." } as never)
  s.use_cases.push({ id: "UC-01", name: "Register account", actor_ids: ["A01"], function_ids: [], description: "Create an account with email.", includes: [], extends: [] } as never)
  s.nfrs.push(
    { id: "NFR-01", category: "security", kind: "quantitative", statement: "The session expires after 15 minutes of inactivity.", priority: null } as never,
    { id: "NFR-02", category: "performance", kind: "quantitative", statement: "The system shall respond within 2 seconds.", priority: null } as never
  )
  return s
}

const at = (found: FoundLocation[], path: string) => found.find((f) => f.path === path)

describe("findSpineLocations + ứng viên vector", () => {
  it("không có vector ⇒ y hệt hành vi cũ (từ khoá), không có vector_score", () => {
    const s = spine()
    const before = findSpineLocations(s, ["actors[id=A01]"], ["respond"])
    expect(findSpineLocations(s, ["actors[id=A01]"], ["respond"], [])).toEqual(before)
    expect(at(before, "nfrs[id=NFR-02]")?.found_by).toEqual(["keyword"])
    expect(before.every((f) => !("vector_score" in f))).toBe(true)
  })

  it("có vector ⇒ thay từ khoá; đồ thị giữ nguyên; phần tử không còn bị bỏ; điểm ghi ở vị trí", () => {
    const found = findSpineLocations(spine(), ["actors[id=A01]"], ["respond"], [
      { ref: "nfrs[id=NFR-01]", score: 0.88 },
      { ref: "use_cases[id=UC-01]", score: 0.82 },
      { ref: "actors[id=A99]", score: 0.99 }
    ])
    expect(found.map((f) => [f.path, f.found_by, f.vector_score])).toEqual([
      ["actors[id=A01]", ["spine_link"], undefined],
      ["use_cases[id=UC-01]", ["spine_link", "vector"], 0.82],
      ["nfrs[id=NFR-01]", ["vector"], 0.88]
    ])
    // từ khoá "respond" không còn là nguồn khi đã có vector
    expect(at(found, "nfrs[id=NFR-02]")).toBeUndefined()
  })
})

const loc = (path: string, found_by: FoundLocation["found_by"], vector_score?: number): FoundLocation => ({
  path,
  section_id: "misc",
  found_by,
  entity_paths: [],
  owner_step: null,
  ...(vector_score !== undefined ? { vector_score } : {})
})

describe("capLocations", () => {
  it("không có vector ⇒ cắt đuôi theo thứ tự tài liệu như cũ", () => {
    const found = [loc("a", ["keyword"]), loc("b", ["spine_link"]), loc("c", ["keyword"])]
    expect(capLocations(found, 2).map((f) => f.path)).toEqual(["a", "b"])
  })

  it("có vector ⇒ giữ mọi vị trí đồ thị, chỗ còn lại cho điểm vector cao nhất; giữ thứ tự tài liệu", () => {
    const found = [loc("v1", ["vector"], 0.81), loc("g1", ["spine_link"]), loc("v2", ["vector"], 0.95), loc("g2", ["mention", "vector"], 0.7), loc("v3", ["vector"], 0.9)]
    expect(capLocations(found, 4).map((f) => f.path)).toEqual(["g1", "v2", "g2", "v3"])
    expect(capLocations(found, 2).map((f) => f.path)).toEqual(["g1", "g2"])
    // đồ thị vượt trần ⇒ cắt đồ thị theo thứ tự tài liệu (như cũ), không còn chỗ cho vector
    expect(capLocations(found, 1).map((f) => f.path)).toEqual(["g1"])
  })

  it("trần MAX_LOCATIONS: 90 ứng viên vector + 2 vị trí đồ thị ⇒ đủ 2 đồ thị + 78 vector điểm cao nhất", () => {
    const s = spine()
    for (let i = 0; i < 90; i++) s.glossary.push({ id: `G${i}`, term: `Term ${i}`, definition: "x" } as never)
    const vector = s.glossary.map((g, i) => ({ ref: `glossary[id=${g.id}]`, score: 0.8 + i / 1000 }))
    const found = findSpineLocations(s, ["actors[id=A01]"], [], vector)
    expect(found).toHaveLength(MAX_LOCATIONS)
    expect(found.filter((f) => f.found_by.includes("spine_link")).map((f) => f.path)).toEqual(["actors[id=A01]", "use_cases[id=UC-01]"])
    const kept = found.filter((f) => f.found_by.includes("vector"))
    expect(kept).toHaveLength(MAX_LOCATIONS - 2)
    expect(Math.min(...kept.map((f) => f.vector_score!))).toBeCloseTo(0.8 + (90 - kept.length) / 1000)
  })
})
