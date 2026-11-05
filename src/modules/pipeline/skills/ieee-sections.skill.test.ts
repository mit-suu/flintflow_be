import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getSkillsDir } from "../../../shared/ai/prompt-assets.js"
import { getSkill } from "../../../shared/ai/prompt-registry.service.js"
import { planTransaction } from "../../spine/op-engine.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Spine } from "../../spine/spine.types.js"

/** FLF-365: ví dụ op trong SKILL.md của 3 skill mục IEEE 29148 chạy được trên Spine mẫu (op hợp lệ, schema cuối lô qua). */
const sampleSpine = (): Spine => {
  const s = createEmptySpine({ name: "EduSchedule", domain: "Education" })
  const fn = (id: string, priority: "must" | "should" | "could" | "wont" | null) => ({
    id, screen_id: null, feature_id: "F1", order: 0, name: id, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority
  })
  const nfr = (id: string) => ({ id, category: "performance" as const, statement: `${id} statement`, kind: "descriptive" as const, priority: "should" as const })
  return {
    ...s,
    features: [{ id: "F1", name: "Scheduling", order: 0 } as Spine["features"][number]],
    functions: [fn("FN001", "must"), fn("FN014", "could"), fn("FN020", "wont"), fn("FN031", null)],
    nfrs: [nfr("N02"), nfr("N03"), nfr("N05")]
  }
}

const exampleOps = (skill: string): unknown[] => {
  const text = fs.readFileSync(path.join(getSkillsDir(), "content", skill, "SKILL.md"), "utf-8")
  const json = /## Example\s+```json\s+([\s\S]*?)```/.exec(text)![1]
  return (JSON.parse(json) as { ops: unknown[] }).ops
}

describe("FLF-365 — skill References / Apportioning / Verification", () => {
  for (const skill of ["references-list", "requirement-apportioning", "verification-matrix"]) {
    it(`${skill}: nạp được (không stub), ví dụ op áp được lên Spine mẫu`, () => {
      expect(getSkill(skill).template).toContain("## Rules")
      const spine = sampleSpine()
      const result = planTransaction(spine, { base_version: spine.spine_version, ops: exampleOps(skill) as never, by: "test" }, { startSeq: 1 })
      expect(result.spine.assumptions).toHaveLength(spine.assumptions.length + 1)
    })
  }

  it("ví dụ apportioning ghi release, verification thêm dòng trỏ đúng yêu cầu", () => {
    const spine = sampleSpine()
    const a = planTransaction(spine, { base_version: spine.spine_version, ops: exampleOps("requirement-apportioning") as never, by: "test" }, { startSeq: 1 }).spine
    expect(a.functions.map((f) => [f.id, f.release ?? null])).toEqual([["FN001", "1.0"], ["FN014", "1.1"], ["FN020", "deferred"], ["FN031", null]])
    const v = planTransaction(spine, { base_version: spine.spine_version, ops: exampleOps("verification-matrix") as never, by: "test" }, { startSeq: 1 }).spine
    expect(v.verifications.map((x) => x.requirement_id)).toEqual(["FN001", "N02", "N05"])
  })
})
