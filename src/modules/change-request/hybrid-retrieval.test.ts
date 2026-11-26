/**
 * C-3 hybrid retrieval — phần hàm thuần: ứng viên vector thay nguồn từ khoá, vị trí đồ thị giữ nguyên, không cắt trần. Chạy trên DB (stub `vectorCandidates`) ở `test/integration/mode1/impact-vector.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { findSpineLocations, type FoundLocation } from "./spine-location.js"

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

  it("FLF-375: có vector ⇒ trộn với từ khoá BM25 (không bỏ từ khoá); đồ thị giữ nguyên; phần tử không còn bị bỏ; điểm ghi ở vị trí", () => {
    // FLF-483: đích actor chỉ kéo use case tham chiếu khi CR xoá ⇒ ca này dùng intent "remove"
    const found = findSpineLocations(
      spine(),
      ["actors[id=A01]"],
      ["respond"],
      [
        { ref: "nfrs[id=NFR-01]", score: 0.88 },
        { ref: "use_cases[id=UC-01]", score: 0.82 },
        { ref: "actors[id=A99]", score: 0.99 }
      ],
      { intent: "remove" }
    )
    expect(found.map((f) => [f.path, f.found_by, f.vector_score])).toEqual([
      ["actors[id=A01]", ["spine_link"], undefined],
      ["use_cases[id=UC-01]", ["spine_link", "vector"], 0.82],
      ["nfrs[id=NFR-01]", ["vector"], 0.88],
      ["nfrs[id=NFR-02]", ["keyword"], undefined]
    ])
    // vị trí theo từ khoá / nghĩa mang điểm trộn RRF để xếp khi phải cắt
    expect(found.filter((f) => f.found_by.every((b) => b === "vector" || b === "keyword")).every((f) => (f.recall_score ?? 0) > 0)).toBe(true)
  })
})

describe("không cắt trần vị trí", () => {
  it("90 ứng viên vector + 2 vị trí đồ thị ⇒ trả đủ 92 vị trí", () => {
    const s = spine()
    for (let i = 0; i < 90; i++) s.glossary.push({ id: `G${i}`, term: `Term ${i}`, definition: "x" } as never)
    const vector = s.glossary.map((g, i) => ({ ref: `glossary[id=${g.id}]`, score: 0.8 + i / 1000 }))
    const found = findSpineLocations(s, ["actors[id=A01]"], [], vector, { intent: "remove" })
    expect(found).toHaveLength(92)
    expect(found.filter((f) => f.found_by.includes("spine_link")).map((f) => f.path)).toEqual(["actors[id=A01]", "use_cases[id=UC-01]"])
    expect(found.filter((f) => f.found_by.includes("vector"))).toHaveLength(90)
  })
})
