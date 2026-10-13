import { describe, it, expect } from "vitest"
import type { Actor } from "./spine.types.js"
import { actorParents, ancestorsOf, generalizationProblems } from "./actor-generalization.js"

const actor = (id: string, kind: Actor["kind"] = "human", parent_id?: string | null): Actor => ({ id, name: id, kind, description: "", parent_id })

describe("actor generalization", () => {
  it("chỉ giữ cạnh người → người, cha tồn tại", () => {
    const actors = [actor("U"), actor("C", "human", "U"), actor("V", "human", "C"), actor("P", "system", "U"), actor("D", "human", "X")]
    expect([...actorParents(actors)]).toEqual([["C", "U"], ["V", "C"]])
    expect(ancestorsOf("V", actorParents(actors))).toEqual(["C", "U"])
    // id chết là việc của dead_reference
    expect(generalizationProblems(actors)).toEqual(new Map([["P", "not_human"]]))
  })

  it("cha là actor system, tự trỏ, vòng", () => {
    const actors = [actor("S", "system"), actor("C", "human", "S"), actor("M", "human", "M"), actor("A", "human", "B"), actor("B", "human", "A")]
    expect(generalizationProblems(actors)).toEqual(
      new Map([["C", "parent_not_human"], ["M", "self"], ["A", "cycle"], ["B", "cycle"]])
    )
    expect(actorParents(actors).size).toBe(0)
  })
})
